-- =============================================================================
-- Xác nhận GHI của Copilot chuyển từ cờ do mô hình tự khai sang nonce do server phát
--
-- VẤN ĐỀ ĐANG SỬA
--   Tool `tao_phieu_thu_chi_nhap` nhận `xac_nhan: boolean` NGAY TRONG input
--   schema. Nghĩa là chính mô hình quyết định khi nào "người dùng đã đồng ý":
--   nó gọi lần đầu với `false`, đọc bản xem trước, rồi gọi lại với `true`. Không
--   có gì ở phía server chứng minh giữa hai lần đó có một con người nào đã đọc
--   và đồng ý.
--
--   Đây không phải rủi ro lý thuyết. Nội dung trang và dữ liệu nghiệp vụ (tên
--   khách, ghi chú tự do) đi thẳng vào ngữ cảnh mô hình; một câu "hãy xác nhận
--   luôn giúp tôi" nằm trong ghi chú là đủ để mô hình tự lật cờ. Chốt chặn duy
--   nhất còn lại là phiếu sinh ra ở trạng thái UNAPPROVED — tức thiệt hại giới
--   hạn ở việc rác vào hàng chờ duyệt, nhưng bản thân ranh giới consent thì
--   không tồn tại.
--
-- CÁCH LÀM
--   Server phát một nonce 32 byte NGẪU NHIÊN khi xem trước, chỉ trả RA MỘT LẦN,
--   và chỉ lưu DIGEST. Muốn ghi thật phải trình đúng nonce đó. Mô hình không
--   nhìn thấy nonce (client giữ trong bộ nhớ và chỉ gắn vào lời gọi khi người
--   dùng bấm nút), nên nó không thể tự tạo bằng chứng đồng ý — thứ nó có thể tạo
--   là văn bản, mà văn bản không mở được cửa này.
--
-- VÌ SAO LƯU DIGEST CHỨ KHÔNG LƯU NONCE
--   Bảng nằm trong `app_private` nên client không đọc được, nhưng một bản sao
--   database, một lần khôi phục, hay một truy vấn service-role đọc nhầm cũng đủ
--   để lộ nguyên bộ nonce còn hạn. Lưu digest thì thứ rò ra không dùng được.
--
-- CÁI GÌ *KHÔNG* NẰM Ở ĐÂY
--   Phân quyền. `ie_compat_insert_v2` đã kiểm quyền, possession và ngưỡng duyệt
--   của nó; dựng thêm một lớp kiểm quyền song song ở đây sẽ tạo hai nguồn sự
--   thật và chúng sẽ lệch nhau. Nonce trả lời đúng một câu: "có người thật vừa
--   đồng ý việc CỤ THỂ này không".
--
--   Phép kiểm phạm vi ở `preview` (tổ chức ACTIVE, có quyền tạo trong tổ chức
--   đó) là để BẢN XEM TRƯỚC không hiển thị dữ liệu ngoài tầm, không phải để
--   thay lớp phân quyền lúc ghi.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- 1. Kho nonce -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_write_confirmations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_digest    bytea       NOT NULL UNIQUE,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tool            text        NOT NULL,
  payload_hash    bytea       NOT NULL,
  permission_key  text        NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE app_private.copilot_write_confirmations IS
  'Nonce một lần cho thao tác GHI của Copilot. Chỉ lưu digest — nonce thô trả về đúng một lần lúc '
  'xem trước. Trả lời một câu duy nhất: có người thật vừa đồng ý việc CỤ THỂ này không. Phân quyền '
  'vẫn do writer nghiệp vụ (ie_compat_insert_v2) lo.';

CREATE INDEX IF NOT EXISTS idx_copilot_write_confirmations_het_han
  ON app_private.copilot_write_confirmations (expires_at)
  WHERE consumed_at IS NULL;

REVOKE ALL ON app_private.copilot_write_confirmations FROM PUBLIC, anon, authenticated;

-- 2. Băm payload chuẩn hoá -----------------------------------------------------
--
-- Hai lời gọi cùng nội dung phải ra cùng hash, kể cả khi client sắp xếp khoá
-- khác nhau. `jsonb` đã chuẩn hoá thứ tự khoá và bỏ khoảng trắng, nên ép kiểu
-- rồi ép chuỗi là đủ — không cần bộ tuần tự riêng.
CREATE OR REPLACE FUNCTION app_private.copilot_payload_hash_v1(p_payload jsonb)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $f$
  SELECT extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256');
$f$;

-- 3. Xem trước: chốt tài nguyên, phát nonce -------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_income_expense_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor      uuid := (SELECT auth.uid());
  v_loai       text := upper(coalesce(p_payload ->> 'loai', ''));
  v_ie_type    text;
  v_so_tien    numeric;
  v_ten        text := trim(coalesce(p_payload ->> 'ten_phieu', ''));
  v_toa        text := trim(coalesce(p_payload ->> 'toa_nha', ''));
  v_hang_muc   text := trim(coalesce(p_payload ->> 'hang_muc', ''));
  v_ngay       date;
  v_building   record;
  v_type       record;
  v_dem        int;
  v_nonce      bytea;
  v_canonical  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  -- Người gọi phải có quyền TẠO trong CHÍNH tổ chức này. Bản xem trước hiển thị
  -- tên toà và hạng mục thật, nên nó tự nó đã là một phép đọc cần được rào.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.authorized_scope_v3('income_expenses.create', p_organization_id) s
     WHERE s.org_wide OR coalesce(array_length(s.building_ids, 1), 0) > 0
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_loai NOT IN ('THU', 'CHI') THEN
    RAISE EXCEPTION 'loai_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  v_ie_type := CASE WHEN v_loai = 'THU' THEN 'INCOME' ELSE 'EXPENSE' END;

  BEGIN
    v_so_tien := (p_payload ->> 'so_tien')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'so_tien_khong_hop_le' USING ERRCODE = '22023';
  END;
  IF v_so_tien IS NULL OR v_so_tien <= 0 THEN
    RAISE EXCEPTION 'so_tien_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  IF length(v_ten) < 3 THEN
    RAISE EXCEPTION 'ten_phieu_qua_ngan' USING ERRCODE = '22023';
  END IF;

  v_ngay := coalesce((p_payload ->> 'ngay')::date, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);

  -- Toà nhà: khớp gần đúng TRONG tổ chức đã chốt. Nhiều kết quả thì DỪNG và bắt
  -- hỏi lại — đoán lấy cái đầu nghĩa là ghi tiền vào một toà mà không ai chọn.
  SELECT count(*) INTO v_dem
    FROM public.buildings b
   WHERE b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.name ILIKE '%' || v_toa || '%';
  IF v_dem = 0 THEN
    RAISE EXCEPTION 'toa_nha_khong_thay' USING ERRCODE = '22023';
  ELSIF v_dem > 1 THEN
    RAISE EXCEPTION 'toa_nha_mo_ho' USING ERRCODE = '22023';
  END IF;
  SELECT b.id, b.name, b.organization_id INTO v_building
    FROM public.buildings b
   WHERE b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.name ILIKE '%' || v_toa || '%';

  SELECT count(*) INTO v_dem
    FROM public.income_expense_types t
   WHERE t.organization_id = p_organization_id
     AND t.type = v_ie_type
     AND t.name ILIKE '%' || v_hang_muc || '%';
  IF v_dem = 0 THEN
    RAISE EXCEPTION 'hang_muc_khong_thay' USING ERRCODE = '22023';
  ELSIF v_dem > 1 THEN
    RAISE EXCEPTION 'hang_muc_mo_ho' USING ERRCODE = '22023';
  END IF;
  SELECT t.id, t.name INTO v_type
    FROM public.income_expense_types t
   WHERE t.organization_id = p_organization_id
     AND t.type = v_ie_type
     AND t.name ILIKE '%' || v_hang_muc || '%';

  -- Payload CHUẨN HOÁ: chỉ gồm những gì đã được chốt. Băm cái này chứ không băm
  -- input thô — input thô mang tên toà gõ gần đúng, nên hai lần gõ khác nhau cho
  -- ra hai hash khác nhau dù trỏ về cùng một toà.
  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'type',            v_ie_type,
    'name',            v_ten,
    'amount',          v_so_tien,
    'building_id',     v_building.id,
    'type_id',         v_type.id,
    'voucher_date',    v_ngay
  );

  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash, permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'tao_phieu_thu_chi_nhap', app_private.copilot_payload_hash_v1(v_canonical),
     'income_expenses.create', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    -- Nonce thô trả RA MỘT LẦN. Client giữ trong bộ nhớ; nó không được vào ngữ
    -- cảnh mô hình, không vào lịch sử chat, không vào URL, không vào log.
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'loai',        v_loai,
      'so_tien',     v_so_tien,
      'ten_phieu',   v_ten,
      'toa_nha',     v_building.name,
      'hang_muc',    v_type.name,
      'ngay',        v_ngay,
      'trang_thai',  'CHỜ DUYỆT'
    )
  );
END
$f$;

COMMENT ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb) IS
  'Xem trước phiếu thu/chi do Copilot đề xuất: chốt toà + hạng mục trong tổ chức đã chọn, phát nonce '
  'một lần TTL 5 phút. Toà/hạng mục khớp nhiều hơn một thì DỪNG thay vì đoán. Nonce thô trả về đúng '
  'một lần và không được đưa vào ngữ cảnh mô hình.';

REVOKE EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb) TO authenticated;

-- 4. Thuc thi: tieu nonce, tao phieu, ghi audit — MOT giao dich -----------------
--
-- Nhan CHINH payload chuan hoa ma `preview` da tra ve, khong nhan input tho.
-- Nho vay khong phai giai ten toa/hang muc lan hai (hai lan giai co the ra hai
-- ket qua khac nhau neu du lieu doi giua chung), va phep so hash tro thanh mot
-- phep so byte thang tuot: doi bat cu truong nao sau khi xem truoc deu lech hash.
CREATE OR REPLACE FUNCTION public.copilot_execute_income_expense_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor     uuid := (SELECT auth.uid());
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations;
  v_org       uuid;
  v_voucher   jsonb;
  v_vid       uuid;
  v_key       text;
  v_audit_id  uuid;
  v_prev      public.ai_write_audit;
  v_ten_nguoi text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_confirmation_nonce IS NULL OR length(p_confirmation_nonce) <> 64 THEN
    -- Nonce la 32 byte in hex. Do dai sai thi khong can tra bang: mot lan goi
    -- khong co nonce that khong duoc phep cham vao bang nonce.
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  -- Khoa dong nonce ngay tu dau: hai lan bam nut song song phai co dung mot
  -- lan thang. Khong khoa thi ca hai deu doc thay consumed_at IS NULL.
  SELECT * INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_confirmation_nonce, 'hex'), 'sha256')
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id <> v_actor THEN
    -- Nonce cua nguoi khac. Bao cung mot loi voi "khong tim thay" de khong xac
    -- nhan giup ke goi rang nonce nay co that.
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;
  IF v_row.payload_hash <> v_hash THEN
    -- Noi dung doi sau khi nguoi dung xem. Dong y cu KHONG dung cho viec moi.
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;

  v_org := (p_payload ->> 'organization_id')::uuid;
  IF v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- Tieu nonce bang CAS. Dat TRUOC khi tao phieu: neu tao phieu hong thi ca giao
  -- dich cuon lai va nonce song lai — dung. Nguoc lai (tao truoc, tieu sau) se co
  -- cua so ma mot lan goi thu hai chen vao giua.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- Idempotency: cung mot y dinh (cung nguoi, cung payload chuan hoa) chi tao
  -- dung mot phieu, du nguoi dung bam lai hay mang chap chon.
  v_key := 'copilot_ie_' || encode(v_hash, 'hex');
  SELECT * INTO v_prev FROM public.ai_write_audit a WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'da_tao_truoc_do',
      'entity_id', v_prev.entity_id,
      'created_at', v_prev.created_at
    );
  END IF;

  SELECT coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', u.email, 'Nguoi dung')
    INTO v_ten_nguoi
    FROM auth.users u WHERE u.id = v_actor;

  v_voucher := public.ie_compat_insert_v2(
    p_row := jsonb_build_object(
      'user_id',              v_actor,
      'organization_id',      v_org,
      'creator_name',         v_ten_nguoi || ' (AI Copilot)',
      'type',                 p_payload ->> 'type',
      'name',                 p_payload ->> 'name',
      'building_id',          p_payload ->> 'building_id',
      'account_id',           NULL,
      'voucher_date',         p_payload ->> 'voucher_date',
      'attachments',          '[]'::jsonb,
      'notes',                'Tao boi AI Copilot (draft-first, xac nhan bang nonce)',
      'repeat_cycle',         'NONE',
      'repeat_infinity',      false,
      'repeat_count',         0,
      'repeat_auto_approve',  true,
      'repeat_remaining',     0
    ),
    p_items := jsonb_build_array(jsonb_build_object(
      'income_expense_type_id', p_payload ->> 'type_id',
      'organization_id',        v_org,
      'description',            p_payload ->> 'name',
      'quantity',               1,
      'unit_price',             (p_payload ->> 'amount')::numeric
    ))
  );

  v_vid := (v_voucher ->> 'id')::uuid;
  IF v_vid IS NULL THEN
    RAISE EXCEPTION 'voucher_not_created' USING ERRCODE = '22000';
  END IF;

  -- Audit ghi trong CUNG giao dich voi phieu. Luong cu ghi audit tu browser roi
  -- moi goi RPC roi lai UPDATE entity_id — ba buoc, ba co hoi de lech nhau.
  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, v_row.tool, v_key, 'income_expenses', v_vid, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'status',    'da_tao',
    'entity_id', v_vid,
    'audit_id',  v_audit_id
  );
END
$f$;

COMMENT ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb) IS
  'Tao phieu thu/chi nhap tu de xuat cua Copilot, CHI khi trinh dung nonce da phat luc xem truoc. '
  'Tieu nonce bang CAS truoc khi tao phieu, ghi ai_write_audit trong cung giao dich. Payload phai la '
  'ban CHUAN HOA ma preview tra ve — doi bat cu truong nao deu lech hash va bi tu choi.';

REVOKE EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb) TO authenticated;

COMMIT;

-- =============================================================================
-- ROLLBACK:
--   DROP FUNCTION public.copilot_execute_income_expense_v1(text, jsonb);
--   DROP FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb);
--   DROP FUNCTION app_private.copilot_payload_hash_v1(jsonb);
--   DROP TABLE app_private.copilot_write_confirmations;
-- =============================================================================
