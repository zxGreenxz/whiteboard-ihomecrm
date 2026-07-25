-- =============================================================================
-- Chốt chặn tạo tay: chuyển từ SO KHỚP TÊN sang ĐỌC CỜ `system_only`
--
-- TRƯỚC (hai chốt, một cái mong manh):
--   IF v_type_is_deposit THEN  RAISE '...tiền cọc' 0A000
--   IF nrm_vn(name) IN ('hoa hong moi gioi','thuong nong sale') THEN RAISE 0A000
--   -> đổi tên hạng mục thành "Hoa hồng MG" là thoát chặn ngay.
--
-- SAU (một chốt, đọc dữ liệu):
--   IF system_only THEN RAISE 0A000
--
-- Cờ đã bật cho ĐÚNG 36 dòng ở 20260725150000 bằng chính hai vị từ cũ, nên hành
-- vi giữ nguyên tuyệt đối. HHMG cố ý KHÔNG nằm trong nhóm này (chủ sở hữu xác
-- nhận là thiết kế có chủ đích) — nó ở mức "cần quyền hạn chế".
--
-- Lợi: đổi tên không phá chặn · một chỗ kiểm thay vì hai · chủ sở hữu tự bật/tắt
-- từng hạng mục ở Cài đặt sau này mà không cần sửa hàm.
--
-- Thông báo lỗi cũng rõ hơn: nêu ĐÚNG TÊN hạng mục bị chặn thay vì câu chung chung.
--
-- Sinh từ pg_get_functiondef bản ĐANG CHẠY; chỉ đổi câu SELECT hạng mục, thêm 1
-- biến, và gộp 2 chốt thành 1. Không đổi gì khác.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_income_expense_v1(p_type text, p_name text, p_building_id uuid, p_room_id uuid, p_tenant_id uuid, p_contract_id uuid, p_payer_name text, p_receive_bank_account text, p_receive_bank_name text, p_account_id uuid, p_attachments jsonb, p_business_result_accounting boolean, p_notes text, p_voucher_date date, p_items jsonb, p_idempotency_key text)
 RETURNS income_expenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$



DECLARE

  -- t5_23/24: trạng thái sinh theo phương án org (cờ hạng mục + ngưỡng chi)
  v_birth_status text;
  v_birth_by uuid;
  v_birth_at timestamptz;
  v_force_cat boolean;
  v_auto_threshold numeric;
  v_maker_can_approve boolean := false;




  v_actor uuid := app_private.current_uid_v1();



  v_claim_cap text;



  v_actor_name text;



  v_name text;



  v_org uuid;



  v_membership_id uuid;



  v_room_id uuid := p_room_id;



  v_tenant_id uuid := p_tenant_id;



  v_contract_room_id uuid;



  v_contract_tenant_id uuid;



  v_contract_deposit_paid_before public.contracts.deposit_paid%TYPE;



  v_contract_updated_at_before public.contracts.updated_at%TYPE;



  v_room_status_before public.rooms.status%TYPE;



  v_room_updated_at_before public.rooms.updated_at%TYPE;



  v_account_owner_id uuid;



  v_account_lock_date date;



  v_account_is_shared boolean := false;



  v_can_create_on_building boolean := false;



  v_can_create_restricted boolean := false;



  v_requires_restricted boolean := false;



  v_row public.income_expenses;



  v_operation app_private.canonical_write_operations%ROWTYPE;



  v_feature app_private.server_feature_flags%ROWTYPE;



  v_feature_route text;



  v_feature_operation_key text;



  v_feature_evaluated_at timestamptz;



  v_item jsonb;



  v_item_count integer;



  v_accrual_bucket_count integer := 0;



  v_index integer := 0;



  v_type_id uuid;



  v_type_is_restricted boolean;



  v_type_is_deposit boolean;



  v_type_normalized_name text;
  v_type_system_only boolean;



  v_quantity numeric;



  v_unit_price_raw numeric;



  v_unit_price numeric;



  v_start_date date;



  v_end_date date;



  v_description text;



  v_expected_type text;



  v_canonical_items jsonb := '[]'::jsonb;



  v_canonical_payload jsonb;



  v_payload_hash text;



  v_idempotency_key text;



  v_total_amount numeric := 0;



  v_feature_operation_count bigint;



  v_feature_total_amount numeric;



  v_stored_item_count bigint;



  v_stored_total_amount numeric;



  v_stored_has_restricted boolean;



  v_stored_counts_in_business_result boolean;



  v_stored_kqkd_amount numeric;



  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);



  c_max_money constant numeric := 9999999999999.99;



  c_max_attachments constant integer := 20;



  c_max_attachment_length constant integer := 2048;



  c_max_name_length constant integer := 500;



  c_max_short_text_length constant integer := 255;



  c_max_notes_length constant integer := 5000;



  c_max_item_description_length constant integer := 1000;



  c_max_item_period_days constant integer := 3660;



  c_max_accrual_buckets constant integer := 2400;



  c_extra_whitespace constant text :=



    chr(160) || chr(173) || chr(5760)



    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)



    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)



    || chr(8202) || chr(8203) || chr(8232) || chr(8233) || chr(8239)



    || chr(8287) || chr(8288) || chr(12288) || chr(65279);



BEGIN



  IF v_actor IS NULL THEN



    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';



  END IF;







  -- A.9 smallest-shape: actor display name via postgres-owned DEFINER delegate



  -- (auth.users/profiles RLS is not part of the writer role's capability set).



  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);



  IF v_actor_name IS NULL THEN



    RAISE EXCEPTION 'Không tìm thấy người dùng hiện tại' USING ERRCODE = '42501';



  END IF;







  -- Platform administration is not tenant business authority. A platform actor



  -- must also hold an active tenant membership and normalized tenant permission;



  -- emergency platform operations belong to a separate, audited endpoint.



  IF p_type NOT IN ('INCOME', 'EXPENSE') THEN



    RAISE EXCEPTION 'Loại phiếu không hợp lệ';



  END IF;



  v_name := btrim(p_name, E' \t\n\r\f\v' || c_extra_whitespace);



  IF p_name IS NULL OR v_name = '' THEN



    RAISE EXCEPTION 'Tên phiếu không được trống';



  END IF;



  IF char_length(v_name) > c_max_name_length THEN



    RAISE EXCEPTION 'Tên phiếu vượt quá % ký tự', c_max_name_length;



  END IF;



  IF p_building_id IS NULL THEN



    RAISE EXCEPTION 'Thiếu building_id';



  END IF;



  IF p_voucher_date IS NULL



     OR NOT isfinite(p_voucher_date)



     OR p_voucher_date < DATE '2000-01-01'



     OR p_voucher_date > DATE '2100-12-31' THEN



    RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31';



  END IF;



  v_idempotency_key := btrim(p_idempotency_key);



  IF v_idempotency_key IS NULL



     OR char_length(v_idempotency_key) < 8



     OR char_length(v_idempotency_key) > 200



     OR v_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN



    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -';



  END IF;



  IF p_payer_name IS NOT NULL



     AND char_length(btrim(p_payer_name)) > c_max_short_text_length THEN



    RAISE EXCEPTION 'Tên người nộp/nhận vượt quá % ký tự', c_max_short_text_length;



  END IF;



  IF p_receive_bank_account IS NOT NULL



     AND char_length(btrim(p_receive_bank_account)) > c_max_short_text_length THEN



    RAISE EXCEPTION 'Số tài khoản nhận vượt quá % ký tự', c_max_short_text_length;



  END IF;



  IF p_receive_bank_name IS NOT NULL



     AND char_length(btrim(p_receive_bank_name)) > c_max_short_text_length THEN



    RAISE EXCEPTION 'Tên ngân hàng nhận vượt quá % ký tự', c_max_short_text_length;



  END IF;



  IF p_notes IS NOT NULL AND char_length(p_notes) > c_max_notes_length THEN



    RAISE EXCEPTION 'Ghi chú vượt quá % ký tự', c_max_notes_length;



  END IF;



  IF jsonb_typeof(v_attachments) <> 'array'



     OR jsonb_array_length(v_attachments) > c_max_attachments



     OR EXISTS (



       SELECT 1



         FROM jsonb_array_elements(v_attachments) x(value)



        WHERE jsonb_typeof(value) <> 'string'



           OR char_length(value #>> '{}') < 1



           OR char_length(value #>> '{}') > c_max_attachment_length



           OR value #>> '{}' ~ '[[:cntrl:]]'



           OR value #>> '{}' !~



                '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^[:space:]\\]*)?$'



     ) THEN



    RAISE EXCEPTION 'attachments phải là mảng tối đa % HTTPS URL an toàn, mỗi URL dài 1-% ký tự',



      c_max_attachments, c_max_attachment_length;



  END IF;



  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN



    RAISE EXCEPTION 'items phải là mảng';



  END IF;



  v_item_count := jsonb_array_length(p_items);



  IF v_item_count < 1 OR v_item_count > 200 THEN



    RAISE EXCEPTION 'Phiếu phải có từ 1 đến 200 hạng mục';



  END IF;







  -- Lock order: organization/building → membership → staff/role scope → room →



  -- tenant → contract/contract_tenant → account/share → item types → feature row.



  SELECT b.organization_id



    INTO v_org



    FROM public.buildings b



    JOIN public.organizations o



      ON o.id = b.organization_id



     AND o.status = 'ACTIVE'



   WHERE b.id = p_building_id



     AND b.deleted_at IS NULL



   FOR SHARE OF o, b;



  IF NOT FOUND OR v_org IS NULL THEN



    RAISE EXCEPTION 'Không tìm thấy toà nhà trong tổ chức đang hoạt động'



      USING ERRCODE = '42501';



  END IF;







  SELECT m.id



    INTO v_membership_id



    FROM public.organization_memberships m



   WHERE m.user_id = v_actor



     AND m.organization_id = v_org



     AND m.status = 'ACTIVE'



     AND m.valid_from <= clock_timestamp()



     AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)



   ORDER BY m.id



   LIMIT 1



   FOR SHARE;



  IF NOT FOUND THEN



    RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức'



      USING ERRCODE = '42501';



  END IF;







  v_can_create_on_building :=



    app_private.authorize_income_expense_on_building(



      v_actor, v_org, 'create', p_building_id



    );







  v_can_create_restricted :=



    app_private.authorize_income_expense_on_building(



      v_actor, v_org, 'restricted_create', p_building_id



    );







  IF p_room_id IS NOT NULL THEN



    PERFORM 1



      FROM public.rooms r



     WHERE r.id = p_room_id



       AND r.deleted_at IS NULL



       AND r.building_id = p_building_id



       AND r.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Phòng không thuộc toà/tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



  END IF;







  IF p_tenant_id IS NOT NULL THEN



    PERFORM 1



      FROM public.tenants t



     WHERE t.id = p_tenant_id



       AND t.deleted_at IS NULL



       AND t.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Khách thuê không thuộc tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



  END IF;







  IF p_contract_id IS NOT NULL THEN



    SELECT c.room_id, c.tenant_id, c.deposit_paid, c.updated_at



      INTO v_contract_room_id, v_contract_tenant_id,



           v_contract_deposit_paid_before, v_contract_updated_at_before



      FROM public.contracts c



      JOIN public.rooms r



        ON r.id = c.room_id



       AND r.deleted_at IS NULL



       AND r.building_id = p_building_id



       AND r.organization_id = v_org



     WHERE c.id = p_contract_id



       AND c.deleted_at IS NULL



       AND c.organization_id = v_org



     FOR SHARE OF c, r;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Hợp đồng không thuộc toà/tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



    IF p_room_id IS NOT NULL AND p_room_id IS DISTINCT FROM v_contract_room_id THEN



      RAISE EXCEPTION 'Hợp đồng không khớp phòng của phiếu'



        USING ERRCODE = '42501';



    END IF;







    IF v_contract_tenant_id IS NOT NULL THEN



      PERFORM 1



        FROM public.tenants t



       WHERE t.id = v_contract_tenant_id



         AND t.deleted_at IS NULL



         AND t.organization_id = v_org



       FOR SHARE;



      IF NOT FOUND THEN



        RAISE EXCEPTION 'Khách thuê đại diện của hợp đồng không còn hợp lệ'



          USING ERRCODE = '42501';



      END IF;



      IF p_tenant_id IS NOT NULL



         AND p_tenant_id IS DISTINCT FROM v_contract_tenant_id THEN



        RAISE EXCEPTION 'Hợp đồng không khớp khách thuê của phiếu'



          USING ERRCODE = '42501';



      END IF;



      v_tenant_id := v_contract_tenant_id;



    ELSIF p_tenant_id IS NOT NULL THEN



      -- contracts.tenant_id is a nullable legacy representative. Only the legacy



      -- contract_tenants relation can prove a supplied tenants.id; contract_customers



      -- references public.customers and must never be used as a tenant bridge.



      PERFORM 1



        FROM public.contract_tenants ct



       WHERE ct.contract_id = p_contract_id



         AND ct.tenant_id = p_tenant_id



         AND (ct.organization_id IS NULL OR ct.organization_id = v_org)



       FOR SHARE;



      IF NOT FOUND THEN



        RAISE EXCEPTION 'Khách thuê không thuộc hợp đồng'



          USING ERRCODE = '42501';



      END IF;



      v_tenant_id := p_tenant_id;



    ELSE



      v_tenant_id := NULL;



    END IF;







    v_room_id := v_contract_room_id;



  END IF;







  IF NOT v_can_create_on_building THEN



    RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này'



      USING ERRCODE = '42501';



  END IF;







  IF v_room_id IS NOT NULL THEN



    SELECT r.status, r.updated_at



      INTO v_room_status_before, v_room_updated_at_before



      FROM public.rooms r



     WHERE r.id = v_room_id



       AND r.deleted_at IS NULL



       AND r.building_id = p_building_id



       AND r.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Phòng hiệu lực không thuộc toà/tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



  END IF;







  IF p_account_id IS NOT NULL THEN



    SELECT a.user_id, a.lock_date



      INTO v_account_owner_id, v_account_lock_date



      FROM public.accounts a



     WHERE a.id = p_account_id



       AND a.deleted_at IS NULL



       AND a.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;







    -- Lock every candidate share row, not only the first match; otherwise a



    -- concurrent revoke of a different matching row can evade the final recheck.



    PERFORM 1



      FROM public.account_shared_users s



     WHERE s.account_id = p_account_id



       AND s.user_id = v_actor



     ORDER BY s.id



     FOR SHARE;



    SELECT EXISTS (



      SELECT 1



        FROM public.account_shared_users s



       WHERE s.account_id = p_account_id



         AND s.user_id = v_actor



         AND (s.organization_id IS NULL OR s.organization_id = v_org)



    ) INTO v_account_is_shared;







    -- Cashbook ownership/sharing remains semantically authoritative until the



    -- normalized cashbooks.post resolver is complete. Building permission never



    -- implies use of an arbitrary same-organization cashbook, while account



    -- ownership/sharing never implies permission to create on the building.



    IF NOT (



      v_account_owner_id = v_actor



      OR v_account_is_shared



    ) THEN



      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này'



        USING ERRCODE = '42501';



    END IF;







  END IF;







  v_expected_type := CASE p_type WHEN 'INCOME' THEN 'income' ELSE 'expense' END;







  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)



  LOOP



    v_index := v_index + 1;



    IF jsonb_typeof(v_item) <> 'object' THEN



      RAISE EXCEPTION 'Hạng mục % phải là object', v_index;



    END IF;



    IF (v_item - ARRAY[



      'income_expense_type_id', 'description', 'quantity', 'unit_price', 'start_date', 'end_date'



    ]) <> '{}'::jsonb THEN



      RAISE EXCEPTION 'Hạng mục % chứa trường không được phép', v_index;



    END IF;



    IF NOT (v_item ? 'income_expense_type_id')



       OR jsonb_typeof(v_item->'income_expense_type_id') <> 'string' THEN



      RAISE EXCEPTION 'Loại thu/chi hạng mục % phải là UUID dạng chuỗi', v_index;



    END IF;



    IF NOT (v_item ? 'quantity')



       OR jsonb_typeof(v_item->'quantity') <> 'number' THEN



      RAISE EXCEPTION 'Số lượng hạng mục % phải là JSON number', v_index;



    END IF;



    IF NOT (v_item ? 'unit_price')



       OR jsonb_typeof(v_item->'unit_price') <> 'number' THEN



      RAISE EXCEPTION 'Đơn giá hạng mục % phải là JSON number', v_index;



    END IF;



    IF NOT (v_item ? 'start_date')



       OR jsonb_typeof(v_item->'start_date') <> 'string'



       OR v_item->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN



      RAISE EXCEPTION 'Ngày bắt đầu hạng mục % phải là YYYY-MM-DD', v_index;



    END IF;



    IF NOT (v_item ? 'end_date')



       OR jsonb_typeof(v_item->'end_date') <> 'string'



       OR v_item->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN



      RAISE EXCEPTION 'Ngày kết thúc hạng mục % phải là YYYY-MM-DD', v_index;



    END IF;



    IF v_item ? 'description'



       AND jsonb_typeof(v_item->'description') NOT IN ('string', 'null') THEN



      RAISE EXCEPTION 'Mô tả hạng mục % phải là chuỗi', v_index;



    END IF;







    BEGIN



      v_type_id := NULLIF(v_item->>'income_expense_type_id', '')::uuid;



      v_quantity := (v_item->>'quantity')::numeric;



      v_unit_price_raw := (v_item->>'unit_price')::numeric;



      v_unit_price := round(v_unit_price_raw, 2);



      v_start_date := (v_item->>'start_date')::date;



      v_end_date := (v_item->>'end_date')::date;



      v_description := NULLIF(btrim(v_item->>'description'), '');



    EXCEPTION



      WHEN invalid_text_representation



        OR invalid_datetime_format



        OR numeric_value_out_of_range



        OR datetime_field_overflow THEN



        RAISE EXCEPTION 'Hạng mục % có dữ liệu không hợp lệ', v_index;



    END;







    IF v_type_id IS NULL THEN



      RAISE EXCEPTION 'Hạng mục % thiếu loại thu/chi', v_index;



    END IF;



    IF v_description IS NOT NULL



       AND char_length(v_description) > c_max_item_description_length THEN



      RAISE EXCEPTION 'Mô tả hạng mục % vượt quá % ký tự',



        v_index, c_max_item_description_length;



    END IF;



    IF v_quantity IS NULL



       OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_quantity < 1



       OR v_quantity > 2147483647



       OR v_quantity <> trunc(v_quantity) THEN



      RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên hợp lệ >= 1', v_index;



    END IF;



    -- Quantity is stored as integer; normalize numeric spelling before hashing.



    v_quantity := trunc(v_quantity);



    IF v_unit_price_raw IS NULL



       OR v_unit_price_raw::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_unit_price_raw < 0



       OR v_unit_price < 0



       OR v_unit_price > c_max_money THEN



      RAISE EXCEPTION 'Đơn giá hạng mục % không hợp lệ', v_index;



    END IF;



    IF v_quantity * v_unit_price > c_max_money THEN



      RAISE EXCEPTION 'Thành tiền hạng mục % vượt giới hạn', v_index;



    END IF;



    IF v_start_date IS NULL



       OR v_end_date IS NULL



       OR NOT isfinite(v_start_date)



       OR NOT isfinite(v_end_date)



       OR v_start_date < DATE '2000-01-01'



       OR v_end_date > DATE '2100-12-31'



       OR v_start_date > v_end_date



       OR v_end_date - v_start_date > c_max_item_period_days THEN



      RAISE EXCEPTION 'Kỳ áp dụng hạng mục % phải nằm trong 2000-01-01..2100-12-31 và không quá % ngày',



        v_index, c_max_item_period_days;



    END IF;



    v_accrual_bucket_count := v_accrual_bucket_count



      + (



          extract(year FROM v_end_date)::integer * 12



          + extract(month FROM v_end_date)::integer



          - extract(year FROM v_start_date)::integer * 12



          - extract(month FROM v_start_date)::integer



          + 1



        );



    IF v_accrual_bucket_count > c_max_accrual_buckets THEN



      RAISE EXCEPTION 'Tổng số bucket dồn tích vượt giới hạn %', c_max_accrual_buckets



        USING ERRCODE = '54000';



    END IF;







    SELECT t.is_restricted, t.is_deposit, public.nrm_vn(t.name), t.system_only
      INTO v_type_is_restricted, v_type_is_deposit, v_type_normalized_name, v_type_system_only



      FROM public.income_expense_types t



     WHERE t.id = v_type_id



       AND lower(t.type) = v_expected_type



       AND t.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Loại hạng mục % không thuộc tổ chức hoặc sai chiều thu/chi', v_index



        USING ERRCODE = '42501';



    END IF;



    -- Chốt chặn tạo tay: đọc CỜ `system_only` trên hạng mục thay vì so khớp TÊN.
    -- Cờ đã được bật cho đúng 36 dòng bằng chính hai vị từ cũ (is_deposit +
    -- tên hoa hồng/thưởng), nên hành vi KHÔNG đổi — chỉ hết mong manh khi đổi tên.
    -- Chủ sở hữu bật/tắt được từng hạng mục ở Cài đặt mà không cần sửa hàm.
    IF coalesce(v_type_system_only, false) THEN
      RAISE EXCEPTION 'Hạng mục "%" chỉ được sinh từ hệ thống (hợp đồng/cọc/thanh lý/hoa hồng), không tạo tay từ màn Thu/Chi',
        (SELECT name FROM public.income_expense_types WHERE id = v_type_id)
        USING ERRCODE = '0A000';
    END IF;



    



    IF v_type_is_restricted THEN



      v_requires_restricted := true;



      IF NOT v_can_create_restricted THEN



        RAISE EXCEPTION 'Không có quyền tạo hạng mục thu/chi hạn chế'



          USING ERRCODE = '42501';



      END IF;



    END IF;







    v_total_amount := v_total_amount + (v_quantity * v_unit_price);



    IF v_total_amount > c_max_money THEN



      RAISE EXCEPTION 'Tổng tiền phiếu vượt giới hạn';



    END IF;







    -- Build the equality token from typed values, not caller UUID/date spelling.



    v_canonical_items := v_canonical_items || jsonb_build_array(



      jsonb_strip_nulls(jsonb_build_object(



        'income_expense_type_id', v_type_id,



        'description', v_description,



        'quantity', v_quantity,



        'unit_price', v_unit_price,



        'start_date', v_start_date,



        'end_date', v_end_date



      ))



    );



  END LOOP;







  v_canonical_payload := jsonb_strip_nulls(jsonb_build_object(



    'type', p_type,



    'name', v_name,



    'building_id', p_building_id,



    'room_id', v_room_id,



    'tenant_id', v_tenant_id,



    'contract_id', p_contract_id,



    'payer_name', NULLIF(btrim(p_payer_name), ''),



    'receive_bank_account', NULLIF(btrim(p_receive_bank_account), ''),



    'receive_bank_name', NULLIF(btrim(p_receive_bank_name), ''),



    'account_id', p_account_id,



    'attachments', v_attachments,



    'business_result_accounting', p_business_result_accounting,



    'notes', NULLIF(p_notes, ''),



    'voucher_date', p_voucher_date,



    'items', v_canonical_items



  ));



  -- md5(jsonb::text) is deterministic for PostgreSQL jsonb canonical key ordering;



  -- payload_hash is an equality token, not a password/signature.



  v_payload_hash := md5(v_canonical_payload::text);







  -- The unconditional unique claim is the linearization point. ON CONFLICT waits



  -- for an in-flight claimant: if it aborts this transaction becomes the claimant;



  -- if it commits the locked reread observes its immutable completion. Rollout state



  -- is deliberately not consulted until after that outcome is known.



  INSERT INTO app_private.canonical_write_operations (



    organization_id, operation, subject_scope, actor_id,



    idempotency_key, payload_hash



  ) VALUES (



    v_org, 'income_expense.create_draft.v1', p_building_id::text, v_actor,



    v_idempotency_key, v_payload_hash



  )



  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)



  DO NOTHING;







  SELECT *



    INTO v_operation



    FROM app_private.canonical_write_operations o



   WHERE o.organization_id = v_org



     AND o.operation = 'income_expense.create_draft.v1'



     AND o.subject_scope = p_building_id::text



     AND o.actor_id = v_actor



     AND o.idempotency_key = v_idempotency_key



   FOR UPDATE;



  IF NOT FOUND THEN



    RAISE EXCEPTION 'Không thể nhận diện operation idempotency đã claim'



      USING ERRCODE = '55000';



  END IF;



  IF v_operation.payload_hash <> v_payload_hash THEN



    RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác'



      USING ERRCODE = '23505';



  END IF;







  -- Completed replay still requires current tenant authority, but it must not depend



  -- on mutable rollout admission, canary enrollment/caps, or the cashbook lock date.



  -- Platform-super status is intentionally irrelevant to tenant business authority.



  IF NOT EXISTS (



    SELECT 1



      FROM public.organization_memberships m



     WHERE m.id = v_membership_id



       AND m.organization_id = v_org



       AND m.user_id = v_actor



       AND m.status = 'ACTIVE'



       AND m.valid_from <= clock_timestamp()



       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)



  ) THEN



    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'



      USING ERRCODE = '42501';



  END IF;



  IF NOT app_private.authorize_income_expense_on_building(



    v_actor, v_org, 'create', p_building_id



  ) THEN



    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF v_requires_restricted



     AND NOT app_private.authorize_income_expense_on_building(



       v_actor, v_org, 'restricted_create', p_building_id



     ) THEN



    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF p_account_id IS NOT NULL



     AND v_account_owner_id IS DISTINCT FROM v_actor



     AND NOT EXISTS (



       SELECT 1



         FROM public.account_shared_users s



        WHERE s.account_id = p_account_id



          AND s.user_id = v_actor



          AND (s.organization_id IS NULL OR s.organization_id = v_org)



     ) THEN



    RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;







  IF v_operation.completed_at IS NOT NULL THEN



    SELECT *



      INTO v_row



      FROM jsonb_populate_record(



        NULL::public.income_expenses,



        v_operation.response_payload



      );



    IF v_row.id IS NULL OR v_row.id IS DISTINCT FROM v_operation.subject_id THEN



      RAISE EXCEPTION 'Kết quả idempotency không còn nhất quán';



    END IF;



    RETURN v_row;



  END IF;







  -- Only a new/pending claimant enters rollout admission. A completed operation above



  -- can therefore replay after OFF/freeze, enrollment removal, or window closure.



  SELECT *



    INTO v_feature



    FROM app_private.server_feature_flags f



   WHERE f.feature_key = 'income_expense.create_draft.v1'



   FOR SHARE;



  IF NOT FOUND THEN



    RAISE EXCEPTION 'Canonical writer chưa được cấu hình' USING ERRCODE = '55000';



  END IF;







  -- A CANARY enrollment used for admission must survive through commit. The shared



  -- feature lock freezes the release identity/configuration for this transaction.



  IF v_feature.mode = 'CANARY' THEN



    PERFORM 1



      FROM app_private.server_feature_flag_canary_orgs c



     WHERE c.feature_key = v_feature.feature_key



       AND c.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Tổ chức không còn trong canary'



        USING ERRCODE = '55000';



    END IF;



  END IF;







  v_feature_route := app_private.evaluate_feature_route(



    v_feature.feature_key, v_org



  );



  IF v_feature_route <> 'CANONICAL' THEN



    RAISE EXCEPTION 'Canonical writer chưa được bật hoặc đang đóng băng cho tổ chức này'



      USING ERRCODE = '55000';



  END IF;







  IF v_feature.mode = 'CANARY' THEN



    -- Serialize only one feature/config cap bucket; do not upgrade the shared row



    -- lock, which would deadlock concurrent readers and globally serialize ON mode.



    PERFORM pg_catalog.pg_advisory_xact_lock(



      pg_catalog.hashtextextended(



        v_feature.feature_key || ':' || v_feature.config_version::text,



        0



      )



    );



    v_feature_evaluated_at := clock_timestamp();



    IF v_feature.starts_at IS NULL



       OR v_feature.ends_at IS NULL



       OR NOT isfinite(v_feature.starts_at)



       OR NOT isfinite(v_feature.ends_at)



       OR v_feature.starts_at >= v_feature.ends_at



       OR v_feature_evaluated_at < v_feature.starts_at



       OR v_feature_evaluated_at >= v_feature.ends_at THEN



      RAISE EXCEPTION 'Cửa sổ canary không còn hiệu lực'



        USING ERRCODE = '55000';



    END IF;



    IF v_feature.max_single_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_feature.max_total_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_feature.max_operation_count <= 0



       OR v_feature.max_single_amount_vnd <= 0



       OR v_feature.max_total_amount_vnd <= 0 THEN



      RAISE EXCEPTION 'Hạn mức canary không hợp lệ'



        USING ERRCODE = '55000';



    END IF;



    IF v_total_amount > v_feature.max_single_amount_vnd THEN



      RAISE EXCEPTION 'Số tiền vượt cap canary cho một phiếu'



        USING ERRCODE = '54000';



    END IF;







    SELECT count(*), COALESCE(sum(o.amount_vnd), 0)



      INTO v_feature_operation_count, v_feature_total_amount



      FROM app_private.server_feature_flag_operations o



     WHERE o.feature_key = v_feature.feature_key



       AND o.config_version = v_feature.config_version;



    IF v_feature_operation_count >= v_feature.max_operation_count THEN



      RAISE EXCEPTION 'Đã hết số lượt canary' USING ERRCODE = '54000';



    END IF;



    IF v_feature_total_amount + v_total_amount > v_feature.max_total_amount_vnd THEN



      RAISE EXCEPTION 'Đã hết tổng hạn mức tiền canary' USING ERRCODE = '54000';



    END IF;



  END IF;







  -- Recheck expiring tenant authority after every idempotency, rollout, enrollment,



  -- and advisory-lock wait. Account lock_date is an effect-only rule: it is applied



  -- here for a new effect but was intentionally skipped by completed replay above.



  IF NOT EXISTS (



    SELECT 1



      FROM public.organization_memberships m



     WHERE m.id = v_membership_id



       AND m.organization_id = v_org



       AND m.user_id = v_actor



       AND m.status = 'ACTIVE'



       AND m.valid_from <= clock_timestamp()



       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)



  ) THEN



    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'



      USING ERRCODE = '42501';



  END IF;



  IF NOT app_private.authorize_income_expense_on_building(



    v_actor, v_org, 'create', p_building_id



  ) THEN



    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF v_requires_restricted



     AND NOT app_private.authorize_income_expense_on_building(



       v_actor, v_org, 'restricted_create', p_building_id



     ) THEN



    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF p_account_id IS NOT NULL THEN



    IF v_account_owner_id IS DISTINCT FROM v_actor



       AND NOT EXISTS (



         SELECT 1



           FROM public.account_shared_users s



          WHERE s.account_id = p_account_id



            AND s.user_id = v_actor



            AND (s.organization_id IS NULL OR s.organization_id = v_org)



       ) THEN



      RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'



        USING ERRCODE = '42501';



    END IF;



    IF v_account_lock_date IS NOT NULL AND p_voucher_date <= v_account_lock_date THEN



      RAISE EXCEPTION 'Sổ quỹ đã khoá tại ngày phiếu';



    END IF;



  END IF;







  IF v_feature.mode = 'CANARY' THEN



    v_feature_operation_key := md5(concat_ws(



      '|',



      'income_expense.create_draft.v1',



      v_org::text,



      p_building_id::text,



      v_actor::text,



      v_idempotency_key



    ));



    INSERT INTO app_private.server_feature_flag_operations (



      feature_key, config_version, operation_key, organization_id, amount_vnd



    ) VALUES (



      v_feature.feature_key, v_feature.config_version, v_feature_operation_key,



      v_org, v_total_amount



    );



  END IF;







  -- Deliberately unresolved: the final T3 containment contract must supply a



  -- server-owned canonical-flow marker that exists at draft creation time. Neither



  -- approval_request_id (NULL before submit) nor the private idempotency ledger is an



  -- acceptable provenance marker. Keep this function revoked until the replacement



  -- source writes that marker atomically with the header and legacy transition guards



  -- reject marked rows.



    -- t5_23/24: chọn trạng thái sinh — auto-duyệt TRỪ hạng mục đặc biệt (cờ
  -- force_approval, gồm hoàn cọc/thanh lý/lương/LN/HH/thưởng...) và TRỪ phiếu
  -- CHI từ ngưỡng cài đặt trở lên (app_private.ie_auto_approve_config; chưa
  -- đặt ngưỡng = tự duyệt như cũ). Phiếu không tự duyệt sinh ở NHÁP chờ duyệt tay.
  SELECT bool_or(coalesce(t.force_approval, false))
    INTO v_force_cat
    FROM jsonb_array_elements(p_items) AS it
    JOIN public.income_expense_types t
      ON t.id = (it->>'income_expense_type_id')::uuid;
  SELECT c.threshold INTO v_auto_threshold
    FROM app_private.ie_auto_approve_config c
   WHERE c.organization_id = v_org;
  -- Chủ sở hữu chốt 2026-07-25: NGƯỜI LẬP PHIẾU MÀ CÓ QUYỀN DUYỆT thì phiếu
  -- tự duyệt ngay lúc tạo, không qua Nháp và không chờ ai. Kiểm bằng mô hình
  -- quyền canonical (app_private.can_v3) — không đọc JSONB legacy.
  -- income_expenses.approve khai required_dimensions=['BUILDING'] nên phiếu không
  -- gắn toà phải hỏi dạng "có quyền ở bất kỳ đâu".
  v_maker_can_approve := CASE
    WHEN p_building_id IS NOT NULL
      THEN app_private.can_v3('income_expenses.approve', p_building_id)
    ELSE app_private.has_any_scope_v3('income_expenses.approve')
  END;

  IF coalesce(v_maker_can_approve, false) THEN
    v_birth_status := 'APPROVED';
  ELSIF coalesce(v_force_cat, false) THEN
    v_birth_status := 'UNAPPROVED';
  ELSIF p_type = 'EXPENSE' AND v_auto_threshold IS NOT NULL
        AND v_total_amount >= v_auto_threshold THEN
    v_birth_status := 'UNAPPROVED';
  ELSE
    v_birth_status := 'APPROVED';
  END IF;
  IF v_birth_status = 'APPROVED' THEN
    v_birth_by := v_actor; v_birth_at := now();
  ELSE
    v_birth_by := NULL; v_birth_at := NULL;
  END IF;

  INSERT INTO public.income_expenses (



    user_id, creator_name, organization_id,



    type, name, building_id, room_id, tenant_id, contract_id,



    payer_name, receive_bank_account, receive_bank_name, account_id,



    attachments, business_result_accounting, notes,



    repeat_cycle, repeat_infinity, repeat_count, repeat_auto_approve,



    repeat_remaining, repeat_next_date,



    voucher_date, approval_status, approved_by, approved_at,



    source_payload_hash, system_source



  ) VALUES (



    v_actor, v_actor_name, v_org,



    p_type, v_name, p_building_id, v_room_id, v_tenant_id, NULL,



    NULLIF(btrim(p_payer_name), ''), NULLIF(btrim(p_receive_bank_account), ''),



    NULLIF(btrim(p_receive_bank_name), ''), p_account_id,



    v_attachments, p_business_result_accounting, NULLIF(p_notes, ''),



    'NONE', false, 0, false,



    0, NULL,



    p_voucher_date, v_birth_status, v_birth_by, v_birth_at,



    v_payload_hash, NULL



  )



  RETURNING * INTO v_row;







  INSERT INTO public.income_expense_items (



    income_expense_id, income_expense_type_id, description,



    quantity, unit_price, start_date, end_date, organization_id



  )



  SELECT



    v_row.id,



    (item->>'income_expense_type_id')::uuid,



    item->>'description',



    (item->>'quantity')::integer,



    (item->>'unit_price')::numeric,



    (item->>'start_date')::date,



    (item->>'end_date')::date,



    v_org



  FROM jsonb_array_elements(v_canonical_items) AS x(item);







  -- Keep the parent detached while non-deposit/non-commission items are inserted.



  -- The legacy item trigger otherwise recomputes any historical approved deposit on



  -- the contract and churns contracts.updated_at even though this draft has no deposit.



  -- Commission flows are excluded above and retain their specialized writer because



  -- their invariants require contract_id on the header before item insertion.



  IF p_contract_id IS NOT NULL THEN



    UPDATE public.income_expenses



       SET contract_id = p_contract_id



     WHERE id = v_row.id



       AND contract_id IS NULL;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Không thể gắn hợp đồng đã xác thực vào phiếu nháp'



        USING ERRCODE = '23514';



    END IF;



  END IF;







  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;







  SELECT count(*), COALESCE(sum(it.amount), 0), COALESCE(bool_or(t.is_restricted), false)



    INTO v_stored_item_count, v_stored_total_amount, v_stored_has_restricted



    FROM public.income_expense_items it



    JOIN public.income_expense_types t ON t.id = it.income_expense_type_id



   WHERE it.income_expense_id = v_row.id;



  v_stored_counts_in_business_result := COALESCE(



    p_business_result_accounting,



    true



  );



  v_stored_kqkd_amount := CASE



    WHEN p_business_result_accounting IS FALSE THEN 0



    ELSE v_total_amount



  END;



  IF v_stored_item_count <> v_item_count



     OR v_stored_total_amount IS DISTINCT FROM v_total_amount



     OR v_row.total_amount IS DISTINCT FROM v_total_amount



     OR v_row.has_restricted_item IS DISTINCT FROM v_stored_has_restricted



     OR v_row.counts_in_business_result IS DISTINCT FROM v_stored_counts_in_business_result



     OR v_row.kqkd_amount IS DISTINCT FROM v_stored_kqkd_amount THEN



    RAISE EXCEPTION 'Trigger thu/chi không tạo đúng các trường tài chính suy diễn'



      USING ERRCODE = '23514';



  END IF;







  -- Generic non-deposit drafts must not reconcile pre-existing deposit or room



  -- reservation state. The earlier row locks make any difference attributable to



  -- this statement; aborting here rolls back the complete writer transaction.



  IF p_contract_id IS NOT NULL AND EXISTS (



    SELECT 1



      FROM public.contracts c



     WHERE c.id = p_contract_id



       AND (



         c.deposit_paid IS DISTINCT FROM v_contract_deposit_paid_before



         OR c.updated_at IS DISTINCT FROM v_contract_updated_at_before



       )



  ) THEN



    RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái tiền cọc hợp đồng'



      USING ERRCODE = '23514';



  END IF;



  IF v_room_id IS NOT NULL AND EXISTS (



    SELECT 1



      FROM public.rooms r



     WHERE r.id = v_room_id



       AND (



         r.status IS DISTINCT FROM v_room_status_before



         OR r.updated_at IS DISTINCT FROM v_room_updated_at_before



       )



  ) THEN



    RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái giữ phòng'



      USING ERRCODE = '23514';



  END IF;







  -- The shared feature-row lock and, for CANARY, shared enrollment lock keep the



  -- admitted rollout identity stable. Re-evaluate only the time boundary here:



  -- counting the reservation we just inserted as a new admission would reject the



  -- exact final permitted count slot (count = max) after its effects were built.



  IF v_feature.mode = 'CANARY' AND (



    clock_timestamp() < v_feature.starts_at



    OR clock_timestamp() >= v_feature.ends_at



  ) THEN



    RAISE EXCEPTION 'Cửa sổ canary đã đóng trước khi hoàn tất'



      USING ERRCODE = '55000';



  END IF;







  -- =========================================================================



  -- T3 CLAIM (A.2 integration point): after construction + invariants +



  -- canary time recheck; before audit append and operation completion.



  -- A.9 smallest-shape: this wrapper is SECURITY DEFINER owned by postgres (so



  -- auth access + INVOKER triggers resolve on Supabase). Capability is proven by



  -- a transaction-local token stamped by a postgres-owned DEFINER setter that no



  -- app role can call, then echoed to the claim. (Replaces the unreachable



  -- current_user='ie_canonical_writer' gate — see t3_12.)



  -- =========================================================================



  v_claim_cap := app_private.grant_ie_claim_capability_v1();



  PERFORM app_private.claim_canonical_income_expense_draft_v1(



    v_row.id, v_idempotency_key, v_claim_cap);



  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;







  -- A.5: canonical audit goes through the single hash-chain primitive; the



  -- audit-log writer-monopoly guard rejects any direct unchained INSERT.



  PERFORM app_private.append_income_expense_event_v1(



    v_org, v_row.id, 'CREATED_DRAFT', v_actor, v_actor_name,



    NULL, v_birth_status,
    CASE WHEN v_birth_status = 'APPROVED'
         THEN 'Tạo phiếu TỰ DUYỆT (ngoài hạng mục đặc biệt, dưới ngưỡng)'
         ELSE 'Tạo phiếu NHÁP chờ duyệt (hạng mục đặc biệt hoặc chi vượt ngưỡng)' END);







  UPDATE app_private.canonical_write_operations



     SET subject_id = v_row.id,



         response_payload = to_jsonb(v_row),



         completed_at = now()



   WHERE organization_id = v_org



     AND operation = 'income_expense.create_draft.v1'



     AND subject_scope = p_building_id::text



     AND actor_id = v_actor



     AND idempotency_key = v_idempotency_key;







  RETURN v_row;



END;



$function$

