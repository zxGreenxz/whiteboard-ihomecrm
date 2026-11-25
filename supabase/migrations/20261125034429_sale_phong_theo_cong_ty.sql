-- =============================================================================
-- Sale phòng, đợt 2 (plan «Sửa trang Sale phòng», chủ duyệt 24/11/2026): link, cài đặt chung và «Phòng trống» theo
-- công ty; chuyển 45/3 TTT về đứng tên nick chủ. Phần máy chủ của lỗi 2, 3, 10 và điều sót S2, S3, S6 (audit 24/11).
--
-- VÌ SAO
--   Mọi thứ của trang Sale khoá theo buildings.user_id («người đứng tên toà»): link chỉ lấy toà đứng tên NGƯỜI TẠO
--   link (quản lý tạo link ⇒ link rỗng), «Phòng trống» chỉ lấy toà đứng tên chủ của người xem, cài đặt chung (hotline,
--   chính sách, số ngày sắp trống) chỉ sửa được khi người sửa đứng tên MỌI toà. Production đo 25/11/2026: 21 toà sống
--   của công ty thật thì 20 toà đứng tên nick chủ, 1 toà (45/3 TTT, 12 phòng) đứng tên một quản lý ⇒ cài đặt chung bị
--   khoá với cả chủ, ảnh danh sách mất khối chính sách, «Phòng trống» thiếu phòng 45/3 TTT. Quyền
--   sale_phong.manage_settings / manage_tokens chỉ ẩn tab; máy chủ không kiểm.
--   Chủ chốt 24/11: link hiện toàn bộ toà của công ty; chuyển 45/3 TTT về đứng tên nick chủ; toà mới ai tạo cũng đứng
--   tên chủ công ty; ai sửa cài đặt chung / quản link theo phân quyền, máy chủ phải kiểm.
--
-- LÀM GÌ
--   1. Dữ liệu (đúng 1 dòng, có guard giá trị cũ): buildings.user_id của 45/3 TTT đổi từ quản lý sang nick chủ. Giá trị
--      cũ ghi vào public.accounting_repair_audit (repair_code SALE_PHONG_DOT2_NGUOI_DUNG_TEN_TOA) để lùi được.
--      Bước 0 trên TEST (25/11): sau khi chuyển, quản lý đó vẫn xem toà, lập + huỷ phiếu thu, lập hoá đơn, trả phòng
--      được như trước (quyền của họ ở toà này đến từ vai «Cộng tác công ty» phạm vi công ty, không từ người đứng tên).
--   2. Luật toà mới (trigger BEFORE INSERT buildings_t1_nguoi_dung_ten_theo_cong_ty, chạy sau buildings_set_user_id_audit):
--      công ty đã có toà sống và mọi toà sống cùng một người đứng tên ⇒ toà mới đứng tên người đó, ai bấm tạo cũng vậy;
--      công ty chưa có toà (hoặc đang lẫn nhiều người đứng tên) ⇒ giữ như cũ (người tạo). Trigger cũ chỉ chạy INSERT.
--   3. app_private.org_building_owner_v1(org): người đứng tên chung của mọi toà sống trong công ty (NULL nếu chưa có toà
--      hoặc lẫn nhiều người). Đây là «chủ cài đặt chung» của công ty: public_room_settings (khoá owner_id), hotline,
--      chính sách sale chung đọc/ghi theo người này.
--   4. get_public_available_rooms(token): link lấy MỌI toà thật của công ty của link (không theo người tạo link); số ngày
--      sắp trống theo người đứng tên từng toà (như bảng nội bộ), hotline/chính sách theo chủ cài đặt chung (hotline cùng
--      công ty), khu vực theo công ty, tin pass theo phòng (một tin hoạt động mỗi phòng, đúng công ty). Phòng đã thuê
--      chỉ còn mã/tầng/tên/diện tích/loại (+ trạng thái để vẽ sơ đồ); giá, cọc, ảnh, nội thất, mô tả, khuyến mãi thành
--      rỗng. Sơ đồ tầng trả cho mọi toà của trang. Link cũ chưa ghi công ty (organization_id NULL) ⇒ không hợp lệ.
--   5. public_sale_rooms_payload_v1 (bot Zalo) và hermes_available_rooms_page_v1 (Hermes): cùng danh sách theo công ty.
--      Mọi link của một công ty giờ ra cùng một trang ⇒ «có trang Sale» = công ty còn ít nhất một link hoạt động
--      (pages / publishedPages = 1, hết link = 0 và không chào phòng — giữ nghĩa «no_sale_page» của bot/Hermes);
--      không còn phụ thuộc link của AI còn sống. Bỏ đường «phòng sẵn sàng đăng thêm qua link»
--      (public_room_link_grants_v1): trang đã gồm mọi toà của công ty nên đường này không còn thêm được phòng nào.
--   6. zalo_sale_advice_delivery_v1: SĐT/chính sách đã đăng đối chiếu theo chủ cài đặt chung, không theo người tạo link.
--   7. get_sale_room_inventory_v1: settings_owner_id / sale_policy / contact theo chủ cài đặt chung của công ty;
--      can_manage_account_settings = có quyền sale_phong.manage_settings (mọi phạm vi; super admin giữ đường cũ) và công
--      ty có chủ cài đặt chung — không còn đòi người xem đứng tên mọi toà.
--   8. get_my_available_rooms(p_organization_id uuid DEFAULT NULL) thay bản không tham số: «Phòng trống» lấy toà của
--      công ty đang chọn mà người xem có rooms.view hoặc sale_phong.view (như bảng nội bộ), không theo «chủ của nhân
--      viên». NULL ⇒ công ty duy nhất; nhiều công ty ⇒ công ty có toà người gọi đứng tên nếu duy nhất, không thì 22023.
--   9. RPC mới có kiểm quyền: get_public_room_settings_v1 / save_public_room_settings_v1 (manage_settings, CAS theo
--      updated_at ⇒ PT409 «đã có người sửa», gửi lại cùng giá trị sau mất phản hồi ⇒ trả như cũ, hotline phải của chủ cài
--      đặt chung trong cùng công ty); list_public_room_tokens_v1 / manage_public_room_token_v1 (manage_tokens: xem mọi
--      link của công ty kèm người tạo, đổi nhãn, thu hồi, khôi phục, xoá).
--  10. Đóng ghi thẳng bảng: REVOKE UPDATE, DELETE trên public_room_share_tokens (đợt 1 đã REVOKE INSERT) và INSERT,
--      UPDATE, DELETE trên public_room_settings khỏi PUBLIC/anon/authenticated — web chuyển sang RPC ở cùng PR.
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm md5(prosrc bỏ CR) mỗi hàm bị thay: thân production đo 25/11/2026 hoặc thân của chính file này (lượt chạy
--   lại); khác ⇒ 55000, không ghi gì. Dữ liệu: đã đứng tên mới ⇒ bỏ qua; đứng tên người thứ ba ⇒ 55000. Hậu kiểm thân,
--   ACL hàm, quyền bảng, trigger, và người đứng tên 45/3 TTT.
--
-- LÙI (migration forward mới): UPDATE public.buildings SET user_id = before_snapshot->>'user_id' theo dòng
--   accounting_repair_audit (repair_code SALE_PHONG_DOT2_NGUOI_DUNG_TEN_TOA); DROP TRIGGER buildings_t1_…; dựng lại sáu
--   hàm bằng nguyên văn thân ghim md5 ở tiền kiểm (get_my_available_rooms: DROP (uuid) rồi CREATE () như cũ); DROP sáu
--   hàm mới; GRANT lại UPDATE, DELETE (link) và INSERT, UPDATE, DELETE (cài đặt) cho anon, authenticated.
-- =============================================================================

-- 0. Tiền kiểm: đúng phụ thuộc, đúng thân đã rà (production 25/11/2026 hoặc bản của file này).
DO $truoc$
DECLARE
  r record;
  v_md5 text;
BEGIN
  IF to_regprocedure('app_private.authorized_scope_v3(text,uuid)') IS NULL
     OR to_regprocedure('app_private.sale_room_can_v1(uuid,uuid,text)') IS NULL
     OR to_regprocedure('app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)') IS NULL
     OR to_regprocedure('app_private.room_sale_policy_overlay_v1(jsonb)') IS NULL
     OR to_regprocedure('app_private.room_exit_hold_json_v1(uuid,uuid)') IS NULL
     OR to_regprocedure('public.my_org_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regclass('public.public_room_share_tokens') IS NULL
     OR to_regclass('public.public_room_settings') IS NULL
     OR to_regclass('public.accounting_repair_audit') IS NULL THEN
    RAISE EXCEPTION 'sale_phong_theo_cong_ty: thiếu phụ thuộc' USING ERRCODE = '55000';
  END IF;
  -- [0] thân production đo 25/11/2026 · [1] thân của chính file này (lượt chạy lại).
  FOR r IN SELECT * FROM (VALUES
      ('public.get_public_available_rooms(text)', '7842895fd40412f10f8308a392c99db5', 'a625ef754a3a17580f7fad8ca045b36a'),
      ('app_private.public_sale_rooms_payload_v1(uuid)', 'f4db947ac466302263911f8391bd4e5f', '5807352fc553877422588a329e758d44'),
      ('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)', '618679c7cab236ce7a63df67233f1036', 'a756a97d00b0845d7cedc8fa6dd5d0b8'),
      ('public.zalo_sale_advice_delivery_v1(uuid,uuid,uuid,text,jsonb)', 'd4ed3c99ba8f9e17d67414c098c0afc4', '53626e7005c800db9077f87504cb1bd2'),
      ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)', '20cb562dbc7c58d98310da44c692a68e', '3b7f70293f0bae23d7906c3203ef2279')
    ) AS v(fn, prod_md5, file_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS NULL OR NOT (v_md5 = ANY (ARRAY[r.prod_md5, r.file_md5])) THEN
      RAISE EXCEPTION '% KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;
  -- get_my_available_rooms: lượt đầu còn bản () thân production; lượt chạy lại chỉ còn bản (uuid) của file này.
  IF to_regprocedure('public.get_my_available_rooms()') IS NOT NULL THEN
    IF to_regprocedure('public.get_my_available_rooms(uuid)') IS NOT NULL THEN
      RAISE EXCEPTION 'get_my_available_rooms: đang có cả hai bản () và (uuid) — DỪNG' USING ERRCODE = '55000';
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.get_my_available_rooms()');
    IF v_md5 IS DISTINCT FROM '8a3b20e5dcfa43b3814874aabe0f6d93' THEN
      RAISE EXCEPTION 'get_my_available_rooms() KHÁC thân đã rà (md5 %) — DỪNG', v_md5 USING ERRCODE = '55000';
    END IF;
  ELSIF to_regprocedure('public.get_my_available_rooms(uuid)') IS NOT NULL THEN
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.get_my_available_rooms(uuid)');
    IF v_md5 IS DISTINCT FROM 'd7bfd2312b3ffbe68e324a9d86fcec93' THEN
      RAISE EXCEPTION 'get_my_available_rooms(uuid) KHÁC thân của file này (md5 %) — DỪNG', v_md5 USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Thiếu public.get_my_available_rooms' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. Người đứng tên chung của công ty (= chủ cài đặt chung) và kiểm quyền Sale ở mọi phạm vi của công ty.
CREATE OR REPLACE FUNCTION app_private.org_building_owner_v1(p_org uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT CASE WHEN count(DISTINCT b.user_id)=1 THEN (array_agg(DISTINCT b.user_id))[1] END
  FROM public.buildings b
  WHERE b.organization_id=p_org AND b.deleted_at IS NULL
$fn$;
COMMENT ON FUNCTION app_private.org_building_owner_v1(uuid) IS
'Người đứng tên chung của mọi toà sống (kể cả toà ảo) trong công ty; NULL nếu chưa có toà hoặc lẫn nhiều người. Là chủ cài đặt chung (public_room_settings, hotline, chính sách sale) của trang Sale công ty và người đứng tên mặc định của toà mới (đợt 2 Sale phòng, 25/11/2026).';
REVOKE ALL ON FUNCTION app_private.org_building_owner_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.sale_org_permission_v1(p_org uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT auth.uid() IS NOT NULL AND (COALESCE(public.is_super_admin(),false) OR EXISTS (
    SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_org) s
    WHERE s.org_wide OR COALESCE(cardinality(s.building_ids),0)>0))
$fn$;
COMMENT ON FUNCTION app_private.sale_org_permission_v1(uuid, text) IS
'Người gọi có quyền p_permission ở bất kỳ phạm vi nào (công ty, khu, toà) của công ty — khớp cách giao diện hiện tab Sale; super admin giữ đường cũ như get_my_permissions. Không kiểm thành viên (hàm gọi kiểm my_org_ids trước).';
REVOKE ALL ON FUNCTION app_private.sale_org_permission_v1(uuid, text) FROM PUBLIC,anon,authenticated,service_role;

-- 2. Luật toà mới: đứng tên người đứng tên chung của công ty.
CREATE OR REPLACE FUNCTION app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_owner uuid;
BEGIN
  IF NEW.organization_id IS NULL THEN RETURN NEW; END IF;
  v_owner:=app_private.org_building_owner_v1(NEW.organization_id);
  IF v_owner IS NOT NULL THEN NEW.user_id:=v_owner; END IF;
  RETURN NEW;
END $fn$;
COMMENT ON FUNCTION app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1() IS
'BEFORE INSERT buildings (sau buildings_set_user_id_audit): công ty đã có toà sống và mọi toà cùng một người đứng tên ⇒ toà mới đứng tên người đó, ai tạo cũng vậy (chủ chốt 24/11/2026). Chưa có toà / lẫn nhiều người ⇒ giữ người tạo.';
REVOKE ALL ON FUNCTION app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS buildings_t1_nguoi_dung_ten_theo_cong_ty ON public.buildings;
CREATE TRIGGER buildings_t1_nguoi_dung_ten_theo_cong_ty BEFORE INSERT ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1();

-- 3. Dữ liệu: 45/3 TTT về đứng tên nick chủ (chủ đồng ý 24/11/2026). Đúng 1 dòng, guard giá trị cũ, biên nhận để lùi.
DO $chuyen$
DECLARE
  c_toa  CONSTANT uuid := 'c4eb87df-758d-4e16-82dc-040f49e6adfc';
  c_org  CONSTANT uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_cu   CONSTANT uuid := 'df8d1df5-1c24-4723-9733-4640c43c382b';
  c_moi  CONSTANT uuid := '90450d5f-29b6-4897-bdef-cdb5fb53f339';
  v_hien uuid;
  v_khac uuid;
  v_n    integer;
BEGIN
  SELECT b.user_id INTO v_hien FROM public.buildings b WHERE b.id=c_toa AND b.organization_id=c_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'sale_phong_theo_cong_ty: không có toà 45/3 TTT (CSDL thử) — bỏ qua bước dữ liệu';
    RETURN;
  END IF;
  IF v_hien=c_moi THEN
    RAISE NOTICE 'sale_phong_theo_cong_ty: 45/3 TTT đã đứng tên nick chủ — bỏ qua';
    RETURN;
  END IF;
  IF v_hien IS DISTINCT FROM c_cu THEN
    RAISE EXCEPTION 'sale_phong_theo_cong_ty: 45/3 TTT đứng tên người khác giá trị đã rà — DỪNG' USING ERRCODE='55000';
  END IF;
  -- Mọi toà sống khác của công ty phải đang đứng tên nick chủ (sau bước này cả công ty một người đứng tên).
  SELECT CASE WHEN count(DISTINCT b.user_id)=1 THEN (array_agg(DISTINCT b.user_id))[1] END INTO v_khac
    FROM public.buildings b WHERE b.organization_id=c_org AND b.deleted_at IS NULL AND b.id<>c_toa;
  IF v_khac IS DISTINCT FROM c_moi THEN
    RAISE EXCEPTION 'sale_phong_theo_cong_ty: các toà khác của công ty không cùng đứng tên nick chủ — DỪNG' USING ERRCODE='55000';
  END IF;
  UPDATE public.buildings SET user_id=c_moi WHERE id=c_toa AND organization_id=c_org AND user_id=c_cu;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n<>1 THEN
    RAISE EXCEPTION 'sale_phong_theo_cong_ty: đổi người đứng tên phải đúng 1 dòng (được %)', v_n USING ERRCODE='55000';
  END IF;
  INSERT INTO public.accounting_repair_audit(organization_id,entity_type,entity_id,repair_code,before_snapshot,after_snapshot,details)
  VALUES (c_org,'building',c_toa,'SALE_PHONG_DOT2_NGUOI_DUNG_TEN_TOA',
    jsonb_build_object('user_id',c_cu),jsonb_build_object('user_id',c_moi),
    jsonb_build_object('migration','20261125034429_sale_phong_theo_cong_ty.sql',
      'ly_do','Chủ chốt 24/11/2026: mọi toà của công ty đứng tên nick chủ để link, cài đặt chung, Phòng trống theo công ty.',
      'lui','UPDATE public.buildings SET user_id=(before_snapshot->>''user_id'')::uuid WHERE id=entity_id'))
  ON CONFLICT (entity_type,entity_id,repair_code) DO NOTHING;
  RAISE NOTICE 'sale_phong_theo_cong_ty: đã chuyển 45/3 TTT về đứng tên nick chủ (1 dòng, có biên nhận)';
END
$chuyen$;

-- 4. Trang công khai /r/:token theo công ty của link.
CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_org uuid;
  v_owner uuid;
  v_hotline uuid;
  v_sale_policy text;
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN NULL;
  END IF;

  -- Link chỉ cho biết CÔNG TY; ai tạo link cũng ra cùng một trang (chủ chốt 24/11/2026).
  SELECT organization_id INTO v_org
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;

  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  -- Hotline và chính sách chung: theo người đứng tên chung các toà của công ty (chủ cài đặt chung).
  v_owner := app_private.org_building_owner_v1(v_org);
  SELECT hotline_id, sale_policy INTO v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      -- Phòng đã thuê chỉ để vẽ sơ đồ tầng: không trả giá, cọc, ảnh, nội thất, mô tả, khuyến mãi.
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN rm.rent_price END AS rent_price,
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN rm.deposit_amount END AS deposit_amount,
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN rm.max_occupants END AS max_occupants,
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN COALESCE(rm.amenities, '[]'::jsonb) ELSE '[]'::jsonb END AS amenities,
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN COALESCE(rm.images, '[]'::jsonb) ELSE '[]'::jsonb END AS images,
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN rm.description END AS description,
      CASE WHEN fact.status_public IN ('free','soon','pass') THEN rm.sale_note END AS sale_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    -- Số ngày sắp trống theo người đứng tên từng toà (như bảng nội bộ get_sale_room_inventory_v1).
    LEFT JOIN public.public_room_settings ps ON ps.owner_id = b.user_id
    -- Một tin pass hoạt động mỗi phòng (room_pass_listings_room_active_uniq), đúng công ty.
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.organization_id = rm.organization_id AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,COALESCE(ps.soon_days,30)) fact
    WHERE b.organization_id = v_org
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.organization_id = v_org AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner AND h.organization_id = v_org
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  v_result := app_private.room_sale_policy_overlay_v1(v_result);
  -- Lớp chính sách có thời hạn ghép cho mọi phòng; phòng đã thuê không mang chữ khuyến mãi ra trang khách.
  RETURN jsonb_set(v_result, '{rooms}', COALESCE((
    SELECT jsonb_agg(CASE WHEN x.item->>'status_public' IN ('free','soon','pass') THEN x.item
      ELSE x.item || jsonb_build_object('sale_note', NULL, 'sale_note_base', NULL, 'active_policy_text', NULL, 'active_policy_ends_at', NULL)
      END ORDER BY x.ord)
    FROM jsonb_array_elements(v_result->'rooms') WITH ORDINALITY AS x(item, ord)), '[]'::jsonb));
END;
$fn$;
COMMENT ON FUNCTION public.get_public_available_rooms(text) IS
'Trang công khai /r/:token: mọi toà thật của CÔNG TY của link (ai tạo link cũng ra cùng trang); hotline + chính sách chung theo người đứng tên chung các toà (app_private.org_building_owner_v1), sắp trống theo người đứng tên từng toà, tin pass theo phòng. Phòng đã thuê chỉ còn mã/tầng/tên/diện tích/loại + trạng thái (vẽ sơ đồ). Link thu hồi / chưa ghi công ty ⇒ NULL (đợt 2 Sale phòng, 25/11/2026).';
REVOKE ALL ON FUNCTION public.get_public_available_rooms(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_available_rooms(text) TO anon, authenticated, service_role;

-- 5. Bot Zalo: danh sách theo công ty; «có trang Sale» = công ty còn link hoạt động.
CREATE OR REPLACE FUNCTION app_private.public_sale_rooms_payload_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_token text; v_page jsonb; v_rooms jsonb; v_buildings jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL,'pages',0);
  END IF;
  -- Mọi link hoạt động của một công ty ra cùng một trang (trang theo công ty) ⇒ đọc qua link sớm nhất. Token không
  -- rời hàm. Hết link ⇒ công ty chưa có trang Sale để gửi khách (pages=0), như trước.
  SELECT t.token INTO v_token FROM public.public_room_share_tokens t
    WHERE t.organization_id=p_organization_id AND t.revoked=false
    ORDER BY t.created_at,t.token LIMIT 1;
  IF v_token IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL,'sale_policy',NULL,'pages',0);
  END IF;
  v_page:=public.get_public_available_rooms(v_token);
  IF v_page IS NULL OR jsonb_typeof(v_page->'buildings') IS DISTINCT FROM 'array' OR jsonb_typeof(v_page->'rooms') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Trang Sale phòng của công ty chưa đọc được' USING ERRCODE='55000'; END IF;
  -- Trang trả MỌI phòng của toà còn chỗ (để vẽ sơ đồ tầng); bản tin chỉ chào phòng còn chào được.
  v_rooms:=COALESCE((SELECT jsonb_agg(pr) FROM jsonb_array_elements(v_page->'rooms') pr
    WHERE pr->>'status_public' IN ('free','soon','pass')
      AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pr->>'building_id')::uuid AND b.organization_id=p_organization_id)),'[]'::jsonb);
  v_buildings:=COALESCE((SELECT jsonb_agg((pb-'floor_layouts') || jsonb_build_object('page_contact_name',v_page#>'{contact,name}', 'page_contact_phone',v_page#>'{contact,phone}', 'page_sale_policy',v_page->'sale_policy')) FROM jsonb_array_elements(v_page->'buildings') pb
    WHERE EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pb->>'id')::uuid AND b.organization_id=p_organization_id)),'[]'::jsonb);
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_buildings) x)<>jsonb_array_length(v_buildings)
    OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_rooms) x)<>jsonb_array_length(v_rooms) THEN
    RAISE EXCEPTION 'Trang Sale phòng của công ty có toà/phòng trùng' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object(
    'areas',COALESCE((SELECT jsonb_agg(a ORDER BY a->>'name',a->>'id') FROM (
        SELECT DISTINCT ON (x->>'id') x AS a FROM jsonb_array_elements(COALESCE(v_page->'areas','[]'::jsonb)) x ORDER BY x->>'id') d),'[]'::jsonb),
    -- Toà còn ít nhất một phòng chào được; thứ tự tên như trang.
    'buildings',COALESCE((SELECT jsonb_agg(x ORDER BY x->>'name',x->>'id') FROM jsonb_array_elements(v_buildings) x
        WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_rooms) r WHERE r->>'building_id'=x->>'id')),'[]'::jsonb),
    'rooms',v_rooms,
    'contact',CASE WHEN jsonb_typeof(v_page->'contact')='object' THEN v_page->'contact' END,
    'sale_policy',CASE WHEN jsonb_typeof(v_page->'sale_policy')='string' THEN v_page->'sale_policy' END,
    'pages',1);
END;
$fn$;
COMMENT ON FUNCTION app_private.public_sale_rooms_payload_v1(uuid) IS
'Bản tin phòng trống của bot Zalo: trang Sale của CÔNG TY (đọc qua link hoạt động sớm nhất; mọi link ra cùng trang), chỉ phòng còn chào được. pages = 1 khi công ty còn link hoạt động, 0 khi hết (bot coi là chưa có trang Sale). Đợt 2 Sale phòng, 25/11/2026.';
REVOKE ALL ON FUNCTION app_private.public_sale_rooms_payload_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- 6. Hermes: trang phòng theo công ty, cùng vị từ với trang công khai.
CREATE OR REPLACE FUNCTION public.hermes_available_rooms_page_v1(p_binding jsonb,p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_building_name text DEFAULT '',p_statuses text[] DEFAULT NULL,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE plan jsonb; v_org uuid; v_scope uuid[]; v_statuses text[]; v_result jsonb;
BEGIN
  plan:=app_private.hermes_room_page_admission_v1(p_binding);
  v_org:=(plan->>'organizationId')::uuid;
  IF p_organization_id IS NULL OR p_organization_id<>v_org THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(v::uuid ORDER BY v::uuid),'{}'::uuid[]) INTO v_scope FROM jsonb_array_elements_text(plan->'buildingIds') v;
  -- Tập tòa rỗng là từ chối (kết nối không còn tòa nào), không phải trang rỗng.
  IF cardinality(v_scope)<1 THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 2000
    OR p_building_name IS NULL OR char_length(p_building_name)>120
    OR (p_building_ids IS NOT NULL AND (cardinality(p_building_ids)<1 OR cardinality(p_building_ids)>256 OR array_ndims(p_building_ids)<>1
      OR array_position(p_building_ids,NULL) IS NOT NULL OR cardinality(p_building_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_building_ids) x)))
    OR (p_statuses IS NOT NULL AND (cardinality(p_statuses)<1 OR cardinality(p_statuses)>3 OR array_ndims(p_statuses)<>1
      OR EXISTS(SELECT 1 FROM unnest(p_statuses) x WHERE x IS NULL OR x NOT IN ('free','soon','pass'))
      OR cardinality(p_statuses)<>(SELECT count(DISTINCT x) FROM unnest(p_statuses) x)))
    THEN RAISE EXCEPTION 'hermes_rooms_page_invalid' USING ERRCODE='22023'; END IF;
  IF p_building_ids IS NOT NULL THEN
    -- Chỉ thu hẹp: mọi tòa yêu cầu phải nằm trong tập DB đã suy ra; ngoài tập là từ chối, không cắt bớt âm thầm.
    IF NOT(p_building_ids<@v_scope) THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg(x ORDER BY x),'{}'::uuid[]) INTO v_scope FROM unnest(p_building_ids) x;
  END IF;
  v_statuses:=COALESCE(p_statuses,ARRAY['free','soon','pass']);
  -- Chép vị từ của public.get_public_available_rooms: trang theo CÔNG TY, có khi công ty còn link hoạt động
  -- (publishedPages 0/1), tòa thật của công ty, sắp trống theo người đứng tên tòa, hotline/chính sách theo chủ cài đặt chung.
  WITH sale_page AS MATERIALIZED (
    SELECT app_private.org_building_owner_v1(v_org) AS owner_id,
      EXISTS (SELECT 1 FROM public.public_room_share_tokens t WHERE t.organization_id=v_org AND t.revoked=false) AS published
  ),
  cb AS MATERIALIZED (
    SELECT b.id,b.name,b.code,b.public_contact_name,b.public_contact_phone,
      CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address
        ELSE concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')) END AS address,
      COALESCE(ps.soon_days,30) AS soon_days,NULLIF(btrim(cs.sale_policy),'') AS page_sale_policy,
      h.name AS page_contact_name,h.phone_number AS page_contact_phone
    FROM public.buildings b
    CROSS JOIN sale_page sp
    LEFT JOIN public.public_room_settings ps ON ps.owner_id=b.user_id
    LEFT JOIN public.public_room_settings cs ON cs.owner_id=sp.owner_id
    LEFT JOIN LATERAL (
      SELECT h.name,h.phone_number FROM public.hotlines h
      WHERE h.user_id=sp.owner_id AND h.organization_id=v_org AND COALESCE(h.is_active,true)=true AND (cs.hotline_id IS NULL OR h.id=cs.hotline_id)
      ORDER BY (h.id=cs.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1) h ON true
    WHERE sp.published AND b.organization_id=v_org AND b.is_virtual=false AND b.deleted_at IS NULL AND b.id=ANY(v_scope)
      AND (p_building_name='' OR strpos(lower(b.name),lower(p_building_name))>0)
  ),
  facts AS MATERIALIZED (
    SELECT rm.id,rm.building_id,rm.floor,rm.name,rm.code,rm.area,rm.rent_price,rm.deposit_amount,
      COALESCE(rm.amenities,'[]'::jsonb) AS amenities,left(rm.description,241) AS description,left((SELECT CASE WHEN active.txt IS NULL THEN rm.sale_note ELSE concat_ws(E'\n',NULLIF(btrim(rm.sale_note),''),active.txt) END FROM (SELECT app_private.room_sale_policy_active_text_v1(rm.organization_id,rm.id,statement_timestamp()) AS txt) active),241) AS sale_note,left(rm.room_type,121) AS room_type,
      -- Overlay khách pass của phòng (một tin hoạt động mỗi phòng, đúng công ty); contact_manager ⇒ che tên/SĐT khách như trang.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_name,81) END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_phone,81) END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN left(pl.sale_policy,241) END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public,fact.sale_state,fact.avail_date,fact.sale_today,fact.expected_ready_on
    FROM public.rooms rm
    JOIN cb ON cb.id=rm.building_id
    LEFT JOIN public.room_pass_listings pl ON pl.room_id=rm.id AND pl.organization_id=rm.organization_id AND pl.active=true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,cb.soon_days) fact
    WHERE rm.organization_id=v_org AND rm.deleted_at IS NULL
  ),
  listed AS MATERIALIZED (
    SELECT f.*,row_number() OVER (ORDER BY cb.name,cb.id,f.floor DESC NULLS LAST,f.name,f.id) AS rn
    FROM facts f JOIN cb ON cb.id=f.building_id
    WHERE f.status_public IN ('free','soon','pass') AND f.status_public=ANY(v_statuses)
  ),
  total AS (SELECT count(*)::integer AS n FROM listed),
  page AS (SELECT * FROM listed WHERE rn>p_offset AND rn<=p_offset+p_limit),
  rooms_j AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'building_id',p.building_id,'floor',p.floor,'name',p.name,'code',p.code,
      'area',p.area,'rent_price',p.rent_price,'deposit_amount',p.deposit_amount,'amenities',p.amenities,'description',p.description,
      'sale_note',p.sale_note,'room_type',p.room_type,'status_public',p.status_public,'sale_state',p.sale_state,'avail_date',p.avail_date,
      'sale_today',p.sale_today,'expected_ready_on',p.expected_ready_on,'pass_contact_name',p.pass_contact_name,
      'pass_contact_phone',p.pass_contact_phone,'pass_sale_policy',p.pass_sale_policy,'pass_price',p.pass_price,
      'pass_avail_date',p.pass_avail_date,'pass_contact_manager',p.pass_contact_manager) ORDER BY p.rn),'[]'::jsonb) AS j
    FROM page p
  ),
  blds_j AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cb.id,'name',cb.name,'code',cb.code,'address',left(cb.address,301),
      'public_contact_name',left(cb.public_contact_name,121),'public_contact_phone',left(cb.public_contact_phone,65),
      'page_contact_name',left(cb.page_contact_name,121),'page_contact_phone',left(cb.page_contact_phone,65)) ORDER BY cb.name,cb.id),'[]'::jsonb) AS j
    FROM cb WHERE cb.id IN (SELECT building_id FROM page)
  ),
  policies_j AS (
    SELECT COALESCE(jsonb_agg(x.page_sale_policy ORDER BY x.first_rn),'[]'::jsonb) AS j FROM (
      SELECT cb.page_sale_policy,min(l.rn) AS first_rn FROM listed l JOIN cb ON cb.id=l.building_id
      WHERE cb.page_sale_policy IS NOT NULL GROUP BY cb.page_sale_policy) x
  )
  SELECT jsonb_build_object('publishedPages',(SELECT CASE WHEN sp.published THEN 1 ELSE 0 END FROM sale_page sp),'totalCount',(SELECT n FROM total),
    'offset',p_offset,'limit',p_limit,
    'nextOffset',CASE WHEN p_offset+p_limit<(SELECT n FROM total) AND p_offset+p_limit<=2000 THEN p_offset+p_limit END,
    'rooms',(SELECT j FROM rooms_j),'buildings',(SELECT j FROM blds_j),'salePolicies',(SELECT j FROM policies_j)) INTO v_result;
  RETURN jsonb_build_object('authority',jsonb_build_object('organizationId',plan->'organizationId','userId',plan->'userId',
    'connectionId',plan->'connectionId','permission',plan->'permission','buildingIds',plan->'buildingIds','cashbookIds',plan->'cashbookIds'),
    'result',v_result);
END $fn$;

-- 7. Tư vấn Sale qua Zalo: SĐT/chính sách đã đăng đối chiếu theo chủ cài đặt chung của công ty (không theo người tạo link).
CREATE OR REPLACE FUNCTION public.zalo_sale_advice_delivery_v1(p_job uuid,p_instance uuid,p_generation uuid,p_signature text DEFAULT NULL,p_memory jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  s app_private.hermes_sale_questions; link text; token_value text; page jsonb;
  signature text; previous jsonb; cfg jsonb; viewing_phone text; page_owner uuid; published_phone text; link_ok boolean:=false;
BEGIN
  SELECT h.* INTO s FROM app_private.hermes_sale_questions h JOIN public.zalo_send_queue q ON q.id=h.job_id
    WHERE h.job_id=p_job AND h.generation=p_generation AND q.processing_instance_id=p_instance AND q.status='processing'
      AND h.organization_id=q.organization_id AND h.account_id=q.account_id AND h.created_at>clock_timestamp()-interval '5 minutes'
      AND q.payload='{"action":"hermes_sale_advice"}'::jsonb;
  IF NOT FOUND OR NOT app_private.hermes_sale_channel_v1(s.organization_id,s.account_id,p_instance,p_generation,s.thread_type,s.thread_id)
    THEN RAISE EXCEPTION 'sale_advice_inactive' USING ERRCODE='42501'; END IF;
  SELECT config INTO cfg FROM public.zalo_automations WHERE organization_id=s.organization_id AND kind='auto_reply';
  SELECT trim(config#>>'{template,shareUrl}') INTO link FROM public.zalo_automations
    WHERE organization_id=s.organization_id AND kind='broadcast_vacant';
  token_value:=substring(link FROM '^https://[A-Za-z0-9.-]+/r/([A-Za-z0-9_-]+)/?$');
  SELECT true INTO link_ok FROM public.public_room_share_tokens t
    WHERE t.token=token_value AND t.organization_id=s.organization_id AND NOT t.revoked;
  IF COALESCE(link_ok,false) THEN
    page:=public.get_public_available_rooms(token_value);
    -- Trang theo công ty: hotline/chính sách là của người đứng tên chung các toà (chủ cài đặt chung).
    page_owner:=app_private.org_building_owner_v1(s.organization_id);
  END IF;
  SELECT page#>>'{contact,phone}' INTO published_phone WHERE EXISTS (
    SELECT 1 FROM public.hotlines h WHERE h.organization_id=s.organization_id AND h.user_id=page_owner
      AND h.phone_number=page#>>'{contact,phone}' AND coalesce(h.is_active,true));
  -- The agreed iHome viewing number belongs only to that organization.
  -- Other organizations use the contact published on their own Sale page.
  viewing_phone:=CASE WHEN s.organization_id='aaaa0000-0000-4000-8000-000000000001'::uuid
    THEN '0923.889.880' ELSE NULLIF(trim(published_phone),'') END;
  IF page IS NOT NULL THEN
    -- The public page is company-scoped. Intersect its published IDs with this
    -- organization; the catalog is used for membership only, never for copy.
    page:=jsonb_build_object(
      'sale_policy',CASE WHEN EXISTS(SELECT 1 FROM public.public_room_settings t
        WHERE t.owner_id=page_owner AND t.organization_id=s.organization_id) THEN page->'sale_policy' END,
      'contact',jsonb_build_object('phone',published_phone),
      'areas',(SELECT coalesce(jsonb_agg(a ORDER BY a->>'id'),'[]') FROM jsonb_array_elements(page->'areas') a
        JOIN public.areas own ON own.id=(a->>'id')::uuid AND own.organization_id=s.organization_id),
      'buildings',(SELECT coalesce(jsonb_agg(b-'floor_layouts' ORDER BY b->>'id'),'[]') FROM jsonb_array_elements(page->'buildings') b
        JOIN public.buildings own ON own.id=(b->>'id')::uuid AND own.organization_id=s.organization_id),
      'rooms',(SELECT coalesce(jsonb_agg(r ORDER BY r->>'id'),'[]') FROM jsonb_array_elements(page->'rooms') r
        JOIN public.rooms own ON own.id=(r->>'id')::uuid AND own.organization_id=s.organization_id
        JOIN public.buildings b ON b.id=own.building_id AND b.id=(r->>'building_id')::uuid AND b.organization_id=s.organization_id
        WHERE r->>'status_public' IN ('free','soon','pass')));
  ELSE link:=NULL; END IF;
  signature:=md5(jsonb_build_array(page,link,viewing_phone,cfg->'blockedKeywords')::text);
  IF p_signature IS NOT NULL THEN
    IF signature<>p_signature THEN RAISE EXCEPTION 'sale_advice_listing_changed' USING ERRCODE='PT409'; END IF;
    IF p_memory IS NOT NULL THEN
      IF jsonb_typeof(p_memory)<>'object' OR octet_length(p_memory::text)>12000 THEN RAISE EXCEPTION 'sale_advice_memory_invalid'; END IF;
      UPDATE app_private.hermes_sale_questions SET memory=p_memory WHERE job_id=p_job;
    END IF;
    RETURN jsonb_build_object('authorized',true,'threadId',s.thread_id,'threadType',s.thread_type);
  END IF;
  SELECT h.memory INTO previous FROM app_private.hermes_sale_questions h
    JOIN public.zalo_send_queue q ON q.id=h.job_id AND q.status='sent'
    WHERE h.organization_id=s.organization_id AND h.account_id=s.account_id AND h.generation=s.generation
      AND h.thread_id=s.thread_id AND h.thread_type=s.thread_type AND h.sender_uid=s.sender_uid AND h.memory IS NOT NULL
      AND h.created_at<s.created_at AND h.created_at>s.created_at-interval '20 minutes' ORDER BY h.created_at DESC LIMIT 1;
  RETURN jsonb_build_object('question',s.question,'previous',previous,'page',page,'link',link,
    'signature',signature,'viewingPhone',viewing_phone,'blockedKeywords',cfg->'blockedKeywords');
END $fn$;

-- 8. Bảng nội bộ: cài đặt chung theo công ty, quyền sửa theo phân quyền.
CREATE OR REPLACE FUNCTION public.get_sale_room_inventory_v1(p_organization_id uuid, p_building_id uuid DEFAULT NULL, p_room_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb; v_owner uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id AND status='ACTIVE')
    OR (public.is_super_admin() AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false)) THEN
    RAISE EXCEPTION 'Không có quyền xem phòng trong tổ chức này' USING ERRCODE='42501';
  END IF;
  -- Chủ cài đặt chung = người đứng tên chung các toà của công ty (không theo tập toà người xem được giao).
  v_owner:=app_private.org_building_owner_v1(p_organization_id);
  WITH allowed_buildings AS MATERIALIZED (
    SELECT b.*,
      app_private.sale_room_can_edit_v1(b.organization_id,b.id) AS can_edit,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_images') AS can_images,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_pass_listings') AS can_pass,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.lock_room') AS can_lock,
      app_private.sale_room_can_v1(b.organization_id,b.id,'deposits.create') AS can_deposit
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT b.is_virtual
      AND (p_building_id IS NULL OR b.id=p_building_id)
      AND (app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.view')
        OR app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.view'))
  ), inventory AS MATERIALIZED (
    SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price,
      r.deposit_amount, r.max_occupants, r.amenities, r.images, r.description,
      r.sale_note, CASE WHEN b.can_edit THEN r.sale_bonus_note END AS sale_bonus_note,
      r.room_type, r.updated_at, md5(to_jsonb(r)::text) AS revision,
      r.sale_status_note AS sale_status_note_raw,r.sale_status_note_key,
      app_private.sale_room_fact_key_v1(r.id,r.organization_id) AS sale_fact_key,
      CASE WHEN r.sale_status_note_key=app_private.sale_room_fact_key_v1(r.id,r.organization_id) THEN r.sale_status_note END AS sale_status_note,
      app_private.room_sale_policy_current_v1(r.organization_id,r.id,statement_timestamp()) AS policy,
      COALESCE((SELECT jsonb_agg(app_private.room_sale_policy_json_v1(p,statement_timestamp()) ORDER BY p.starts_at,p.id)
        FROM app_private.room_sale_policies_v1 p WHERE p.organization_id=r.organization_id AND p.room_id=r.id
          AND p.cancelled_at IS NULL AND p.ends_at>statement_timestamp()),'[]'::jsonb) AS policies,
      app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp()) AS active_policy_text,
      NULLIF(concat_ws(E'\n',NULLIF(btrim(r.sale_note),''),app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp())),'') AS effective_sale_note,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      CASE WHEN lk.id IS NOT NULL THEN jsonb_build_object(
        'id',lk.id,'hours',lk.hours,'note',lk.note,'locked_at',lk.locked_at,'expires_at',lk.expires_at,
        'locked_by_name',COALESCE(NULLIF(btrim(lp.full_name),''),'Người dùng'),
        'locked_by_me',lk.locked_by=auth.uid()) END AS sale_lock,
      app_private.room_exit_hold_json_v1(r.organization_id,r.id) AS exit_hold,
      jsonb_build_object(
        'edit',b.can_edit,'images',b.can_edit OR b.can_images,'pass',b.can_pass,
        'lock',b.can_lock AND fact.status_public IN ('free','soon') AND lk.id IS NULL,
        'releaseLock',lk.id IS NOT NULL AND ((lk.locked_by=auth.uid() AND b.can_lock) OR b.can_deposit),
        'deposit',b.can_deposit
      ) AS capabilities,
      audit.updated_by_name
    FROM public.rooms r
    JOIN allowed_buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    LEFT JOIN public.public_room_settings settings ON settings.owner_id=b.user_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id=r.id AND pl.organization_id=r.organization_id AND pl.active
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(
      r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
    ) fact
    LEFT JOIN LATERAL (
      SELECT l.* FROM public.room_sale_locks l
      WHERE l.room_id=r.id AND l.organization_id=r.organization_id
        AND l.released_at IS NULL AND l.expires_at>now()
        AND fact.status_public='rented'
        AND EXISTS (SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(
          r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
        ) base WHERE base.status_public IN ('free','soon'))
      ORDER BY l.locked_at DESC LIMIT 1
    ) lk ON true
    LEFT JOIN public.profiles lp ON lp.id=lk.locked_by
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng') AS updated_by_name
      FROM app_private.sale_room_change_receipts cr
      LEFT JOIN public.profiles p ON p.id=cr.actor_id
      WHERE cr.room_id=r.id AND cr.organization_id=r.organization_id
        AND cr.response->>'revision'=md5(to_jsonb(r)::text)
      ORDER BY cr.created_at DESC LIMIT 1
    ) audit ON true
    WHERE r.organization_id=p_organization_id AND r.deleted_at IS NULL
      AND (p_room_id IS NULL OR r.id=p_room_id)
  )
  SELECT jsonb_build_object(
    'server_now',statement_timestamp(),'areas','[]'::jsonb,
    'next_policy_boundary_at',(SELECT min(boundary) FROM app_private.room_sale_policies_v1 p
      JOIN inventory i ON i.id=p.room_id CROSS JOIN LATERAL (VALUES(p.starts_at),(p.ends_at)) d(boundary)
      WHERE p.organization_id=p_organization_id AND p.cancelled_at IS NULL AND boundary>statement_timestamp()),
    'settings_owner_id',v_owner,
    'can_manage_account_settings',(v_owner IS NOT NULL AND app_private.sale_org_permission_v1(p_organization_id,'sale_phong.manage_settings')),
    'sale_policy',(SELECT NULLIF(btrim(s.sale_policy),'') FROM public.public_room_settings s WHERE s.owner_id=v_owner),
    'contact',(SELECT jsonb_build_object('name',h.name,'phone',h.phone_number) FROM public.hotlines h
      LEFT JOIN public.public_room_settings s ON s.owner_id=h.user_id
      WHERE h.user_id=v_owner AND h.organization_id=p_organization_id
      AND COALESCE(h.is_active,true) AND (s.hotline_id IS NULL OR h.id=s.hotline_id)
      ORDER BY (h.id=s.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1),
    'rooms',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.building_id,i.floor,i.name,i.id) FROM inventory i),'[]'::jsonb),
    'buildings',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',b.id,'name',b.name,'code',b.code,'district',b.district,'ward',b.ward,
      'address',concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')),
      'total_floors',b.total_floors,'images',b.images,'public_contact_name',b.public_contact_name,
      'public_contact_phone',b.public_contact_phone,'public_map_url',b.public_map_url,
      'public_lift_type',b.public_lift_type,
      'floor_layouts',b.floor_layouts,
      'area_ids',COALESCE((SELECT jsonb_agg(ab.area_id ORDER BY ab.area_id) FROM public.area_buildings ab
        JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=b.organization_id AND a.deleted_at IS NULL
        WHERE ab.building_id=b.id AND ab.organization_id=b.organization_id),'[]'::jsonb),
      'elec_rate',(SELECT COALESCE(bs.unit_price_override,s.unit_price) FROM public.building_services bs
        JOIN public.services s ON s.id=bs.service_id WHERE bs.building_id=b.id AND bs.is_active
        AND s.deleted_at IS NULL AND s.unit ILIKE 'kwh' ORDER BY (s.type='FIXED') DESC,s.unit_price LIMIT 1)
    ) ORDER BY b.name,b.id) FROM allowed_buildings b
      WHERE EXISTS (SELECT 1 FROM inventory i WHERE i.building_id=b.id)),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END
$fn$;
REVOKE ALL ON FUNCTION public.get_sale_room_inventory_v1(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sale_room_inventory_v1(uuid, uuid, uuid) TO authenticated;

-- 9. «Phòng trống» (điện thoại) theo công ty đang chọn và quyền xem phòng.
DROP FUNCTION IF EXISTS public.get_my_available_rooms();
CREATE OR REPLACE FUNCTION public.get_my_available_rooms(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_caller  uuid := auth.uid();
  v_orgs    uuid[];
  v_org     uuid := p_organization_id;
  v_owner   uuid;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  -- Công ty: công ty đang chọn. Bản web cũ không gửi ⇒ công ty duy nhất của người gọi; thuộc nhiều công ty thì công
  -- ty có toà người gọi đứng tên nếu duy nhất (đường cũ của nick chủ), không thì bắt chọn — không đoán.
  v_orgs := COALESCE(public.my_org_ids(), '{}'::uuid[]);
  IF v_org IS NULL THEN
    IF cardinality(v_orgs) = 1 THEN
      v_org := v_orgs[1];
    ELSE
      SELECT CASE WHEN count(DISTINCT b.organization_id) = 1 THEN (array_agg(DISTINCT b.organization_id))[1] END INTO v_org
        FROM public.buildings b
       WHERE b.user_id = v_caller AND b.deleted_at IS NULL AND b.organization_id = ANY (v_orgs);
      IF v_org IS NULL THEN
        RAISE EXCEPTION 'my_available_rooms_org_required' USING ERRCODE = '22023',
          HINT = 'Tài khoản thuộc nhiều công ty: gửi p_organization_id của công ty đang chọn.';
      END IF;
    END IF;
  ELSIF NOT (v_org = ANY (v_orgs)) THEN
    RAISE EXCEPTION 'my_available_rooms_not_member' USING ERRCODE = '42501',
      HINT = 'Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;

  -- Hotline và chính sách chung: theo người đứng tên chung các toà của công ty (chủ cài đặt chung).
  v_owner := app_private.org_building_owner_v1(v_org);
  SELECT hotline_id, sale_policy INTO v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- 10/10 (Tình trạng gõ tay): chỉ trả chữ khi tình trạng tự tính vẫn như lúc gõ.
      CASE WHEN rm.sale_status_note_key = fk.sale_fact_key THEN rm.sale_status_note END AS sale_status_note,
      fk.sale_fact_key,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      lk.sale_lock,
      app_private.room_exit_hold_json_v1(rm.organization_id,rm.id) AS exit_hold
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    -- Số ngày sắp trống theo người đứng tên từng toà (như bảng nội bộ).
    LEFT JOIN public.public_room_settings ps ON ps.owner_id = b.user_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.organization_id = rm.organization_id AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,COALESCE(ps.soon_days,30)) fact
    CROSS JOIN LATERAL (
      -- format giữ chỗ cho NULL (concat_ws bỏ qua NULL ⇒ hai tình trạng khác nhau có thể trùng khoá);
      -- ngày qua to_char để khoá không phụ thuộc DateStyle của phiên.
      SELECT md5(format('%s|%s|%s|%s|%s|%s', fact.status_public, fact.sale_state,
                        to_char(fact.avail_date, 'YYYY-MM-DD'), to_char(fact.expected_ready_on, 'YYYY-MM-DD'),
                        CASE WHEN fact.status_public = 'pass' THEN pl.id END,
                        CASE WHEN fact.status_public = 'pass' THEN to_char(pl.avail_date, 'YYYY-MM-DD') END)) AS sale_fact_key
    ) fk
    -- 10/10: phòng bị ẩn CHỈ vì lock tạm còn hạn ⇒ nhân viên trong app thấy ai lock, còn bao lâu.
    -- Reader công khai/Zalo/Copilot không có khoá này; trạng thái vẫn 'rented' như phòng đã cọc.
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id', l.id, 'hours', l.hours, 'note', l.note,
               'locked_at', l.locked_at, 'expires_at', l.expires_at,
               'locked_by_name', COALESCE(NULLIF(btrim(p.full_name), ''), 'Người dùng'),
               'locked_by_me', l.locked_by = v_caller) AS sale_lock
      FROM public.room_sale_locks l
      LEFT JOIN public.profiles p ON p.id = l.locked_by
      WHERE fact.status_public = 'rented'
        AND l.organization_id = rm.organization_id AND l.room_id = rm.id
        AND l.released_at IS NULL AND l.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,COALESCE(ps.soon_days,30)) base
          WHERE base.status_public IN ('free','soon'))
    ) lk ON true
    WHERE b.organization_id = v_org
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
      -- Như bảng nội bộ: toà người xem có quyền xem phòng hoặc xem trang Sale.
      AND (app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.view')
        OR app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.view'))
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass') OR sale_lock IS NOT NULL OR exit_hold IS NOT NULL
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.organization_id = v_org AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner AND h.organization_id = v_org
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN app_private.room_sale_policy_overlay_v1(v_result);
END;
$fn$;
COMMENT ON FUNCTION public.get_my_available_rooms(uuid) IS
'«Phòng trống» trong app: toà của công ty p_organization_id (NULL ⇒ công ty duy nhất; nhiều công ty ⇒ công ty có toà người gọi đứng tên nếu duy nhất, không thì 22023) mà người xem có rooms.view hoặc sale_phong.view; hotline/chính sách theo người đứng tên chung các toà. Đợt 2 Sale phòng, 25/11/2026.';
REVOKE ALL ON FUNCTION public.get_my_available_rooms(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_available_rooms(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_available_rooms(uuid) TO service_role;

-- 10. Cài đặt chung của công ty: đọc / lưu có kiểm quyền và CAS.
CREATE OR REPLACE FUNCTION app_private.public_room_settings_json_v1(p_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  WITH o AS (SELECT app_private.org_building_owner_v1(p_org) AS owner_id),
  s AS (SELECT ps.* FROM public.public_room_settings ps JOIN o ON ps.owner_id=o.owner_id)
  SELECT jsonb_build_object(
    'organization_id',p_org,
    'owner_id',(SELECT owner_id FROM o),
    'exists',EXISTS(SELECT 1 FROM s),
    'soon_days',COALESCE((SELECT soon_days FROM s),30),
    'show_rented',COALESCE((SELECT show_rented FROM s),true),
    'hotline_id',(SELECT hotline_id FROM s),
    'sale_policy',(SELECT sale_policy FROM s),
    'updated_at',(SELECT updated_at FROM s),
    'can_manage',((SELECT owner_id FROM o) IS NOT NULL AND app_private.sale_org_permission_v1(p_org,'sale_phong.manage_settings')),
    'hotlines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'name',h.name,'phone_number',h.phone_number,
        'is_active',h.is_active,'created_at',h.created_at) ORDER BY h.created_at DESC,h.id)
      FROM public.hotlines h, o WHERE h.user_id=o.owner_id AND h.organization_id=p_org),'[]'::jsonb))
$fn$;
REVOKE ALL ON FUNCTION app_private.public_room_settings_json_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_public_room_settings_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501';
  END IF;
  IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'public_room_settings_not_member' USING ERRCODE='42501',
      HINT='Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;
  IF NOT (app_private.sale_org_permission_v1(p_organization_id,'sale_phong.view')
       OR app_private.sale_org_permission_v1(p_organization_id,'sale_phong.manage_settings')) THEN
    RAISE EXCEPTION 'public_room_settings_permission' USING ERRCODE='42501',
      HINT='Cần quyền xem trang Sale phòng ở công ty này.';
  END IF;
  RETURN app_private.public_room_settings_json_v1(p_organization_id);
END
$fn$;
COMMENT ON FUNCTION public.get_public_room_settings_v1(uuid) IS
'Cài đặt chung trang Sale của công ty (số ngày sắp trống, hotline, chính sách sale) = dòng public_room_settings của người đứng tên chung các toà; kèm hotline của người đó trong công ty, updated_at (khoá CAS) và can_manage. Cần thành viên + sale_phong.view hoặc manage_settings. Đợt 2 Sale phòng.';
REVOKE ALL ON FUNCTION public.get_public_room_settings_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_room_settings_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_public_room_settings_v1(p_organization_id uuid, p_expected_updated_at timestamptz,
  p_soon_days integer, p_show_rented boolean, p_hotline_id uuid DEFAULT NULL, p_sale_policy text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_owner uuid;
  v_row public.public_room_settings%ROWTYPE;
  v_found boolean;
  v_policy text := NULLIF(btrim(COALESCE(p_sale_policy,'')),'');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501';
  END IF;
  IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'public_room_settings_not_member' USING ERRCODE='42501',
      HINT='Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;
  IF NOT app_private.sale_org_permission_v1(p_organization_id,'sale_phong.manage_settings') THEN
    RAISE EXCEPTION 'public_room_settings_permission' USING ERRCODE='42501',
      HINT='Cần quyền sale_phong.manage_settings (Cài đặt hiển thị) ở công ty này.';
  END IF;
  IF p_soon_days IS NULL OR p_soon_days NOT BETWEEN 0 AND 365 OR p_show_rented IS NULL
     OR char_length(COALESCE(v_policy,''))>2000 THEN
    RAISE EXCEPTION 'public_room_settings_invalid' USING ERRCODE='22023',
      HINT='Số ngày sắp trống là số nguyên 0–365, chính sách sale chung tối đa 2000 ký tự.';
  END IF;
  -- Một lượt lưu mỗi công ty tại một thời điểm.
  PERFORM pg_advisory_xact_lock(hashtextextended('public_room_settings:'||p_organization_id::text,0));
  v_owner:=app_private.org_building_owner_v1(p_organization_id);
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'public_room_settings_owner_ambiguous' USING ERRCODE='55000',
      HINT='Công ty chưa có toà hoặc các toà đứng tên nhiều người; chưa xác định được cài đặt chung.';
  END IF;
  IF p_hotline_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hotlines h WHERE h.id=p_hotline_id
      AND h.user_id=v_owner AND h.organization_id=p_organization_id AND COALESCE(h.is_active,true)) THEN
    RAISE EXCEPTION 'public_room_settings_hotline_invalid' USING ERRCODE='22023',
      HINT='Hotline phải là hotline đang bật của cài đặt chung công ty.';
  END IF;
  SELECT * INTO v_row FROM public.public_room_settings WHERE owner_id=v_owner FOR UPDATE;
  v_found:=FOUND;
  IF v_found AND v_row.organization_id IS NOT NULL AND v_row.organization_id<>p_organization_id THEN
    RAISE EXCEPTION 'public_room_settings_owner_other_org' USING ERRCODE='55000',
      HINT='Dòng cài đặt của người đứng tên đang thuộc công ty khác.';
  END IF;
  -- Gửi lại sau mất phản hồi (hoặc người khác đã lưu đúng giá trị này): trả như hiện có, không báo xung đột.
  IF v_found AND v_row.soon_days=p_soon_days AND v_row.show_rented=p_show_rented
     AND v_row.hotline_id IS NOT DISTINCT FROM p_hotline_id
     AND NULLIF(btrim(COALESCE(v_row.sale_policy,'')),'') IS NOT DISTINCT FROM v_policy THEN
    RETURN app_private.public_room_settings_json_v1(p_organization_id)||jsonb_build_object('changed',false);
  END IF;
  IF (v_found AND v_row.updated_at IS DISTINCT FROM p_expected_updated_at)
     OR (NOT v_found AND p_expected_updated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'public_room_settings_conflict' USING ERRCODE='PT409',
      HINT='Đã có người sửa cài đặt chung sau khi bạn mở; tải lại rồi sửa tiếp.';
  END IF;
  INSERT INTO public.public_room_settings(owner_id,organization_id,soon_days,show_rented,hotline_id,sale_policy,updated_at)
  VALUES (v_owner,p_organization_id,p_soon_days,p_show_rented,p_hotline_id,v_policy,clock_timestamp())
  ON CONFLICT (owner_id) DO UPDATE SET soon_days=EXCLUDED.soon_days, show_rented=EXCLUDED.show_rented,
    hotline_id=EXCLUDED.hotline_id, sale_policy=EXCLUDED.sale_policy, updated_at=EXCLUDED.updated_at;
  RETURN app_private.public_room_settings_json_v1(p_organization_id)||jsonb_build_object('changed',true);
END
$fn$;
COMMENT ON FUNCTION public.save_public_room_settings_v1(uuid, timestamptz, integer, boolean, uuid, text) IS
'Lưu cài đặt chung trang Sale của công ty vào dòng của người đứng tên chung các toà. Kiểm thành viên + sale_phong.manage_settings (mọi phạm vi; super admin giữ đường cũ). CAS: p_expected_updated_at phải khớp updated_at đang có (NULL khi chưa có dòng), lệch ⇒ PT409 public_room_settings_conflict; cùng giá trị ⇒ trả như cũ (changed=false). Hotline phải của người đứng tên trong công ty. Đợt 2 Sale phòng.';
REVOKE ALL ON FUNCTION public.save_public_room_settings_v1(uuid, timestamptz, integer, boolean, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_public_room_settings_v1(uuid, timestamptz, integer, boolean, uuid, text) TO authenticated;

-- 11. Link chia sẻ của công ty: xem / đổi nhãn / thu hồi / khôi phục / xoá có kiểm quyền.
CREATE OR REPLACE FUNCTION app_private.public_room_token_json_v1(t public.public_room_share_tokens)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('token',t.token,'label',t.label,'revoked',t.revoked,'created_at',t.created_at,
    'owner_id',t.owner_id,'organization_id',t.organization_id,
    'owner_name',(SELECT COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng') FROM public.profiles p WHERE p.id=t.owner_id))
$fn$;
REVOKE ALL ON FUNCTION app_private.public_room_token_json_v1(public.public_room_share_tokens) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.list_public_room_tokens_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501';
  END IF;
  IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'public_room_token_not_member' USING ERRCODE='42501',
      HINT='Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;
  IF NOT app_private.sale_org_permission_v1(p_organization_id,'sale_phong.manage_tokens') THEN
    RAISE EXCEPTION 'public_room_token_permission' USING ERRCODE='42501',
      HINT='Cần quyền sale_phong.manage_tokens (Quản lý link chia sẻ) ở công ty này.';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(app_private.public_room_token_json_v1(t) ORDER BY t.created_at DESC, t.token)
    FROM public.public_room_share_tokens t WHERE t.organization_id=p_organization_id),'[]'::jsonb);
END
$fn$;
COMMENT ON FUNCTION public.list_public_room_tokens_v1(uuid) IS
'Mọi link chia sẻ của công ty (kể cả do người khác tạo, kể cả đã thu hồi) kèm tên người tạo. Cần thành viên + sale_phong.manage_tokens (mọi phạm vi; super admin giữ đường cũ). Đợt 2 Sale phòng.';
REVOKE ALL ON FUNCTION public.list_public_room_tokens_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_public_room_tokens_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.manage_public_room_token_v1(p_organization_id uuid, p_token text, p_action text, p_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_row public.public_room_share_tokens%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501';
  END IF;
  IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'public_room_token_not_member' USING ERRCODE='42501',
      HINT='Tài khoản không phải thành viên đang hoạt động của công ty này.';
  END IF;
  IF NOT app_private.sale_org_permission_v1(p_organization_id,'sale_phong.manage_tokens') THEN
    RAISE EXCEPTION 'public_room_token_permission' USING ERRCODE='42501',
      HINT='Cần quyền sale_phong.manage_tokens (Quản lý link chia sẻ) ở công ty này.';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('rename','revoke','restore','delete') OR p_token IS NULL OR p_token=''
     OR char_length(COALESCE(p_label,''))>200 THEN
    RAISE EXCEPTION 'public_room_token_invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_row FROM public.public_room_share_tokens
   WHERE token=p_token AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Xoá lại một link đã xoá (mất phản hồi lần trước) là xong; thao tác khác báo không thấy link trong công ty.
    IF p_action='delete' THEN RETURN jsonb_build_object('token',p_token,'removed',false); END IF;
    RAISE EXCEPTION 'public_room_token_not_found' USING ERRCODE='P0002',
      HINT='Không thấy link này trong công ty đang chọn.';
  END IF;
  IF p_action='delete' THEN
    DELETE FROM public.public_room_share_tokens WHERE token=v_row.token;
    RETURN app_private.public_room_token_json_v1(v_row)||jsonb_build_object('removed',true);
  ELSIF p_action='rename' THEN
    UPDATE public.public_room_share_tokens SET label=NULLIF(btrim(COALESCE(p_label,'')),'') WHERE token=v_row.token RETURNING * INTO v_row;
  ELSE
    UPDATE public.public_room_share_tokens SET revoked=(p_action='revoke') WHERE token=v_row.token RETURNING * INTO v_row;
  END IF;
  RETURN app_private.public_room_token_json_v1(v_row)||jsonb_build_object('removed',false);
END
$fn$;
COMMENT ON FUNCTION public.manage_public_room_token_v1(uuid, text, text, text) IS
'Đổi nhãn (rename) / thu hồi (revoke) / khôi phục (restore) / xoá (delete) một link của công ty, kể cả link người khác tạo. Cần thành viên + sale_phong.manage_tokens (mọi phạm vi; super admin giữ đường cũ). Xoá link không còn ⇒ removed=false. Thay cho ghi thẳng bảng (đã REVOKE UPDATE, DELETE). Đợt 2 Sale phòng.';
REVOKE ALL ON FUNCTION public.manage_public_room_token_v1(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_public_room_token_v1(uuid, text, text, text) TO authenticated;

-- 12. Đóng ghi thẳng bảng: mọi thay đổi link / cài đặt chung đi qua RPC đã kiểm quyền ở trên.
REVOKE UPDATE, DELETE ON public.public_room_share_tokens FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.public_room_settings FROM PUBLIC, anon, authenticated;

-- 13. Hậu kiểm: đúng thân, đúng quyền gọi, đúng quyền bảng, có trigger, đúng người đứng tên 45/3 TTT.
DO $sau$
DECLARE
  r record;
  v_md5 text;
  v_owner uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_public_available_rooms(text)', 'a625ef754a3a17580f7fad8ca045b36a'),
      ('app_private.public_sale_rooms_payload_v1(uuid)', '5807352fc553877422588a329e758d44'),
      ('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)', 'a756a97d00b0845d7cedc8fa6dd5d0b8'),
      ('public.zalo_sale_advice_delivery_v1(uuid,uuid,uuid,text,jsonb)', '53626e7005c800db9077f87504cb1bd2'),
      ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)', '3b7f70293f0bae23d7906c3203ef2279'),
      ('public.get_my_available_rooms(uuid)', 'd7bfd2312b3ffbe68e324a9d86fcec93'),
      ('app_private.org_building_owner_v1(uuid)', '98019a8f321b6b8f39d98db7f487e89c'),
      ('app_private.sale_org_permission_v1(uuid,text)', '607841b199b8cd5b2383d74b67f319a4'),
      ('app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1()', '8b6a19d2636b72f5ffcc4f62bc982f14'),
      ('app_private.public_room_settings_json_v1(uuid)', '979942342611cd137462cb9e391ef9ea'),
      ('public.get_public_room_settings_v1(uuid)', '176ff333422f5d398c9bb4d2d106a879'),
      ('public.save_public_room_settings_v1(uuid,timestamptz,integer,boolean,uuid,text)', '422d067b8c433dd4aaf01ca19f33419f'),
      ('app_private.public_room_token_json_v1(public.public_room_share_tokens)', '3803598b8ad0cc68b47bb4d327ed0e3a'),
      ('public.list_public_room_tokens_v1(uuid)', '51ff1d57320c4524557c5a2cd14d505a'),
      ('public.manage_public_room_token_v1(uuid,text,text,text)', '92976fab875ec3670c40f6de3478d30a')
    ) AS v(fn, file_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.file_md5 THEN
      RAISE EXCEPTION 'Hậu kiểm: % không phải thân của file này (md5 %)', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) g WHERE p.oid = to_regprocedure(r.fn) AND g.grantee = 0)
       OR (r.fn <> 'public.get_public_available_rooms(text)' AND has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE')) THEN
      RAISE EXCEPTION 'Hậu kiểm: % còn cấp PUBLIC/anon', r.fn USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF to_regprocedure('public.get_my_available_rooms()') IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: còn bản get_my_available_rooms() cũ' USING ERRCODE = '55000';
  END IF;
  -- Hàm gọi từ web: authenticated; hàm riêng: không vai API nào.
  IF NOT has_function_privilege('authenticated', 'public.get_my_available_rooms(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_my_available_rooms(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_public_room_settings_v1(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_public_room_settings_v1(uuid,timestamptz,integer,boolean,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.list_public_room_tokens_v1(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.manage_public_room_token_v1(uuid,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_public_available_rooms(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.org_building_owner_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.sale_org_permission_v1(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.public_room_settings_json_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.public_room_token_json_v1(public.public_room_share_tokens)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.public_sale_rooms_payload_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền gọi hàm sai' USING ERRCODE = '55000';
  END IF;
  IF has_table_privilege('authenticated', 'public.public_room_share_tokens', 'INSERT')
     OR has_table_privilege('authenticated', 'public.public_room_share_tokens', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.public_room_share_tokens', 'DELETE')
     OR has_table_privilege('anon', 'public.public_room_share_tokens', 'UPDATE')
     OR has_table_privilege('anon', 'public.public_room_share_tokens', 'DELETE')
     OR has_table_privilege('authenticated', 'public.public_room_settings', 'INSERT')
     OR has_table_privilege('authenticated', 'public.public_room_settings', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.public_room_settings', 'DELETE')
     OR has_table_privilege('anon', 'public.public_room_settings', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.public_room_share_tokens', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.public_room_settings', 'SELECT') THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền bảng link / cài đặt sai (chỉ còn SELECT cho authenticated)' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.buildings'::regclass
       AND t.tgname = 'buildings_t1_nguoi_dung_ten_theo_cong_ty' AND NOT t.tgisinternal
       AND t.tgfoid = 'app_private.buildings_nguoi_dung_ten_theo_cong_ty_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'Hậu kiểm: thiếu trigger người đứng tên toà mới' USING ERRCODE = '55000';
  END IF;
  SELECT b.user_id INTO v_owner FROM public.buildings b
   WHERE b.id = 'c4eb87df-758d-4e16-82dc-040f49e6adfc' AND b.organization_id = 'aaaa0000-0000-4000-8000-000000000001';
  IF FOUND AND v_owner IS DISTINCT FROM '90450d5f-29b6-4897-bdef-cdb5fb53f339'::uuid THEN
    RAISE EXCEPTION 'Hậu kiểm: 45/3 TTT chưa đứng tên nick chủ' USING ERRCODE = '55000';
  END IF;
END
$sau$;

NOTIFY pgrst, 'reload schema';
