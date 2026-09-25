-- =============================================================================
-- sua_phieu_cho_duyet — sửa phiếu thu chi Chờ duyệt, mọi lần sửa có dấu vết
-- Ngày 25/09/2026 · đợt 1 "sửa phiếu thu chi" · chủ chốt: "chỉ cần đang chờ
-- duyệt thì muốn sửa gì sửa nhưng toàn bộ thao tác sửa chữa sẽ ghi chú lại chính
-- xác rõ ràng dễ hiểu và đánh dấu để khi người duyệt họ duyệt thì có thể check"
-- =============================================================================
-- VÌ SAO
--   Phiếu lập tay qua màn Thu/Chi bị niêm phong ngay lúc lập (Phương án A 18/07):
--   đang Chờ duyệt cũng không sửa được, phải huỷ rồi "Tạo bản sao" — phiếu bản sao
--   không nối về phiếu cũ nên người duyệt không thấy đã đổi gì. Phiếu hệ thống
--   (hoa hồng, trả khách thanh lý) thì ngược lại: sửa tiền được mà không để lại lý
--   do (vụ PC2608134 bớt 2.050.000). Đo prod 25/09 (chỉ đọc): 184 phiếu Chờ duyệt
--   = 80 lập tay cũ + 16 lập tay niêm phong + 49 hoa hồng + 39 trả khách thanh lý.
--
-- LÀM GÌ
--   1. Thêm scope 'REVISE' vào ie_flex_writer_xids_scope_chk.
--   2. Bảng public.income_expense_revisions: mỗi lần sửa một dòng (ai, lúc nào, lý
--      do, trường đổi, ảnh chụp TRƯỚC/SAU có sẵn tên toà/phòng/khách/HĐ/sổ/hạng
--      mục). Chỉ đọc qua RLS (cùng tầm nhìn phiếu), không sửa/xoá được.
--   3. app_private.ie_revision_snapshot_v1(uuid): ảnh chụp phiếu để hiển thị.
--   4. app_private.is_income_expense_flow_owned(uuid): trả false khi CHÍNH
--      transaction đang mở cửa REVISE cho đúng phiếu đó ⇒ guard niêm phong đã ghim
--      (guard_income_expense_owned_payload, không đổi byte nào) và guard hạng mục
--      nhường cho trigger mới kiểm delta.
--   5. Trigger a01_ie_revise_scope_delta (app_private.ie_revise_scope_delta_guard):
--      trong cửa REVISE chỉ cho đổi cột nội dung + cột suy ra + approval_version,
--      phiếu phải Chờ duyệt và chưa ghi sổ.
--   6. Writer public.revise_pending_income_expense_v1(p_voucher,
--      p_expected_approval_version, p_patch, p_items, p_reason, p_idempotency_key):
--      khoá org → khoá phiếu → CAS approval_version → kiểm loại phiếu, quyền, dữ
--      liệu (cùng luật với create_income_expense_v1) → chỉ ghi khi có thay đổi
--      thật → approval_version + 1, lưu lịch sử, ghi nhật ký phiếu.
--      Lý do ≥ 8 ký tự khi đổi Thu/Chi, toà, sổ quỹ, KQKD hoặc số/loại/đơn giá/kỳ
--      của hạng mục. Phiếu hoa hồng / trả khách thanh lý chỉ đổi được tiền của
--      hạng mục đang có, sổ quỹ, ngày, người nhận, tên, ảnh, ghi chú.
--      Đổi Thu ↔ Chi thì cấp mã MỚI đúng tiền tố PT/PC từ bộ đếm chung
--      (app_private.next_voucher_code_v1 — migration mã phiếu duy nhất); số cũ bỏ.
--      Sửa xong vẫn Chờ duyệt; không tự duyệt.
--   7. public.approve_pending_income_expense_checked_v1(p_voucher,
--      p_expected_approval_version): nút Duyệt gửi kèm phiên bản đang xem; phiếu vừa
--      bị sửa ⇒ PT409 (HTTP 409) "tải lại". Duyệt vẫn đi approve_income_expense_v1 (phiếu
--      thuộc luồng) / approve_voucher (phiếu cũ) như hiện nay.
--   8. approve_income_expense_v1: chỉ đổi câu báo "phiếu canonical không sửa được:
--      Huỷ rồi Tạo bản sao" (hết đúng) thành "bấm Sửa phiếu, chọn sổ quỹ".
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu đang có (chỉ thêm bảng/hàm/trigger/ràng buộc). Không đụng
--   hàm/trigger đã ghim (guard_income_expense_owned_payload, a00_ie_owned_payload_
--   freeze, finance_v2_birth_provenance_bridge, a86_…). Không đụng birth_*,
--   source_payload_hash, flow_ownership.payload_hash_value (assert_committed_birth_
--   boundary_v2 so hash đã lưu, không tính lại — đã kiểm 25/09).
--   Kênh sửa cũ (ie_compat_update_pending_v2) đóng ở migration sau khi web mới lên.
--
-- ĐƯỜNG LÙI
--   REVOKE EXECUTE revise_pending_income_expense_v1 khỏi authenticated (dừng sửa
--   ngay); CREATE OR REPLACE is_income_expense_flow_owned về bản md5 bd4e54b1…;
--   DROP TRIGGER a01_ie_revise_scope_delta. Bảng lịch sử để nguyên (dấu vết).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Bản đang chạy phải đúng bản đã rà. Hai guard niêm phong phải đúng bản mà
--    lối vòng qua is_income_expense_flow_owned dựa vào (early-return khi phiếu
--    "không thuộc luồng").
DO $truoc$
DECLARE
  v_ham record;
BEGIN
  FOR v_ham IN
    SELECT * FROM (VALUES
      ('app_private.is_income_expense_flow_owned(uuid)',
       ARRAY['bd4e54b15e1c12dbe22a0bc0088e2f3e', '2a3e6fa637585023d823ce591e756ec0']),
      ('app_private.guard_income_expense_owned_payload()',
       ARRAY['fb01ae8c9de7b283d19ade8195eba726']),
      ('app_private.guard_income_expense_owned_items()',
       ARRAY['1f0d1e2eb19975cdd52693a703ee464a']),
      ('app_private.begin_ie_flex_write_v1(uuid,text)',
       ARRAY['a340a615e2eb4358c7b9f2c5251426c3']),
      ('app_private.end_ie_flex_write_v1(uuid)',
       ARRAY['a2ca25eec94494e86a335596758a9fab']),
      ('public.approve_income_expense_v1(uuid)',
       ARRAY['c80b22a0fe986cb67f128b9fc869ebcc', '10fdb43c85df855db3ab9c26be7ee6e1'])
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
-- 1. Scope REVISE.
DO $scope$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('app_private.ie_flex_writer_xids') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_flex_writer_xids' USING ERRCODE = '55000';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'app_private.ie_flex_writer_xids'::regclass
     AND c.conname = 'ie_flex_writer_xids_scope_chk';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Thiếu ie_flex_writer_xids_scope_chk' USING ERRCODE = '55000';
  END IF;
  IF position('''REVISE''' IN v_def) > 0 THEN
    RETURN; -- đã thêm
  END IF;
  IF v_def <> 'CHECK ((scope = ANY (ARRAY[''ANNOTATE''::text, ''FLEX_EDIT''::text, ''LINK_CONTRACT''::text, ''SALE_BONUS_DEPOSIT''::text, ''CASHBOOK_MOVE''::text, ''HANDOVER''::text, ''STOP_RECURRING''::text])))' THEN
    RAISE EXCEPTION 'ie_flex_writer_xids_scope_chk khác bản đã đối chiếu (%) — dừng lại, đối chiếu tay', v_def
      USING ERRCODE = '55000';
  END IF;

  ALTER TABLE app_private.ie_flex_writer_xids
    DROP CONSTRAINT ie_flex_writer_xids_scope_chk;
  ALTER TABLE app_private.ie_flex_writer_xids
    ADD CONSTRAINT ie_flex_writer_xids_scope_chk
    CHECK (scope IN ('ANNOTATE', 'FLEX_EDIT', 'LINK_CONTRACT', 'SALE_BONUS_DEPOSIT',
                     'CASHBOOK_MOVE', 'HANDOVER', 'STOP_RECURRING', 'REVISE'));
END
$scope$;

-- ---------------------------------------------------------------------------
-- 2. Lịch sử sửa phiếu.
CREATE TABLE IF NOT EXISTS public.income_expense_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  revision_no integer NOT NULL CHECK (revision_no >= 1),
  kind text NOT NULL CHECK (kind IN ('EDIT_PENDING', 'COLLECTION_METHOD')),
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 1000),
  changed_fields text[] NOT NULL CHECK (cardinality(changed_fields) >= 1),
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (income_expense_id, revision_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS income_expense_revisions_idem
  ON public.income_expense_revisions (income_expense_id, actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS income_expense_revisions_org
  ON public.income_expense_revisions (organization_id);

ALTER TABLE public.income_expense_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.income_expense_revisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.income_expense_revisions TO authenticated;

-- Cùng tầm nhìn với phiếu (khuôn của Bổ sung phiếu).
DROP POLICY IF EXISTS income_expense_revisions_select ON public.income_expense_revisions;
CREATE POLICY income_expense_revisions_select ON public.income_expense_revisions
  FOR SELECT TO authenticated
  USING (app_private.ie_supplement_can_read_v1(income_expense_id));
DROP POLICY IF EXISTS income_expense_revisions_hide_sandbox_admin ON public.income_expense_revisions;
CREATE POLICY income_expense_revisions_hide_sandbox_admin ON public.income_expense_revisions
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)));

CREATE OR REPLACE FUNCTION app_private.ie_revision_immutable_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  RAISE EXCEPTION 'Lịch sử sửa phiếu đã lưu không được sửa hoặc xoá' USING ERRCODE = '55000';
END
$function$;
REVOKE ALL ON FUNCTION app_private.ie_revision_immutable_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ie_revision_immutable ON public.income_expense_revisions;
CREATE TRIGGER ie_revision_immutable
  BEFORE UPDATE OR DELETE ON public.income_expense_revisions
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_revision_immutable_v1();
DROP TRIGGER IF EXISTS ie_revision_no_truncate ON public.income_expense_revisions;
CREATE TRIGGER ie_revision_no_truncate
  BEFORE TRUNCATE ON public.income_expense_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.ie_revision_immutable_v1();

-- ---------------------------------------------------------------------------
-- 3. Ảnh chụp phiếu để hiển thị (tên thay cho id; hạng mục xếp ổn định theo nội
--    dung vì mỗi lần sửa hạng mục được ghi lại với id mới).
CREATE OR REPLACE FUNCTION app_private.ie_revision_snapshot_v1(p_voucher uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  SELECT jsonb_build_object(
    'code', ie.code,
    'type', ie.type,
    'name', ie.name,
    'voucher_date', ie.voucher_date,
    'building', CASE WHEN ie.building_id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', ie.building_id, 'name', b.name) END,
    'room', CASE WHEN ie.room_id IS NULL THEN NULL
                 ELSE jsonb_build_object('id', ie.room_id, 'name', r.name) END,
    'tenant', CASE WHEN ie.tenant_id IS NULL THEN NULL
                   ELSE jsonb_build_object('id', ie.tenant_id, 'name', t.full_name) END,
    'contract', CASE WHEN ie.contract_id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', ie.contract_id,
                                             'code', COALESCE(c.public_code, c.contract_number)) END,
    'account', CASE WHEN ie.account_id IS NULL THEN NULL
                    ELSE jsonb_build_object('id', ie.account_id, 'name', a.name) END,
    'payer_name', ie.payer_name,
    'receive_bank_account', ie.receive_bank_account,
    'receive_bank_name', ie.receive_bank_name,
    'business_result_accounting', ie.business_result_accounting,
    'notes', ie.notes,
    'attachments', COALESCE(ie.attachments, '[]'::jsonb),
    'repeat', jsonb_build_object('cycle', ie.repeat_cycle, 'count', ie.repeat_count,
                                 'infinity', ie.repeat_infinity, 'auto_approve', ie.repeat_auto_approve),
    'total_amount', ie.total_amount,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'type_id', it.income_expense_type_id,
               'type_name', ty.name,
               'description', it.description,
               'quantity', it.quantity,
               'unit_price', it.unit_price,
               'amount', it.amount,
               'start_date', it.start_date,
               'end_date', it.end_date)
             ORDER BY ty.name, it.start_date NULLS FIRST, it.end_date NULLS FIRST,
                      it.unit_price, it.quantity, it.description NULLS FIRST, it.id)
        FROM public.income_expense_items it
        LEFT JOIN public.income_expense_types ty ON ty.id = it.income_expense_type_id
       WHERE it.income_expense_id = ie.id), '[]'::jsonb))
  FROM public.income_expenses ie
  LEFT JOIN public.buildings b ON b.id = ie.building_id
  LEFT JOIN public.rooms r ON r.id = ie.room_id
  LEFT JOIN public.tenants t ON t.id = ie.tenant_id
  LEFT JOIN public.contracts c ON c.id = ie.contract_id
  LEFT JOIN public.accounts a ON a.id = ie.account_id
  WHERE ie.id = p_voucher
$function$;
REVOKE ALL ON FUNCTION app_private.ie_revision_snapshot_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Niêm phong nhường cửa REVISE của CHÍNH transaction này cho đúng phiếu này.
--    pg_current_xact_id_if_assigned(): hàm STABLE không được tự cấp xid; chưa có
--    xid thì chắc chắn chưa mở cửa nào.
CREATE OR REPLACE FUNCTION app_private.is_income_expense_flow_owned(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
  select exists (
    select 1 from app_private.income_expense_flow_ownership
     where income_expense_id = p_id)
  and not exists (
    -- Đợt 1 sửa phiếu (25/09/2026): trigger a01_ie_revise_scope_delta kiểm delta
    -- thay cho niêm phong trong đúng cửa REVISE của writer
    -- revise_pending_income_expense_v1.
    select 1 from app_private.ie_flex_writer_xids w
     where w.income_expense_id = p_id
       and w.scope = 'REVISE'
       and w.transaction_id = pg_current_xact_id_if_assigned()
       and w.backend_pid = pg_backend_pid());
$function$;

-- ---------------------------------------------------------------------------
-- 5. Trigger kiểm delta trong cửa REVISE.
CREATE OR REPLACE FUNCTION app_private.ie_revise_scope_delta_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_cho_doi text[];
BEGIN
  -- Chỉ soi khi CHÍNH transaction này đã mở cửa REVISE cho phiếu này.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid()
       AND w.scope = 'REVISE'
  ) THEN
    RETURN NEW;
  END IF;

  IF OLD.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR NEW.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR COALESCE(OLD.posting_status, 'UNPOSTED') = 'POSTED'
     OR OLD.active_posting_id_v2 IS NOT NULL
     OR NEW.active_posting_id_v2 IS NOT NULL
     OR OLD.deleted_at IS NOT NULL
     OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cửa sửa phiếu chỉ dùng cho phiếu Chờ duyệt chưa ghi sổ (phiếu %)', OLD.id
      USING ERRCODE = '55000';
  END IF;

  v_cho_doi := ARRAY[
    -- nội dung phiếu
    'type', 'name', 'building_id', 'room_id', 'tenant_id', 'contract_id',
    'payer_name', 'receive_bank_account', 'receive_bank_name', 'account_id',
    'attachments', 'notes', 'voucher_date', 'business_result_accounting',
    'repeat_cycle', 'repeat_count', 'repeat_infinity', 'repeat_auto_approve',
    'repeat_remaining', 'repeat_next_date',
    -- cột suy ra do trigger hạng mục
    'total_amount', 'kqkd_amount', 'counts_in_business_result',
    'has_restricted_item', 'commission_kind',
    -- phiên bản
    'approval_version', 'updated_at'];

  -- Đổi Thu ↔ Chi thì mã phải đổi tiền tố theo loại (PT/PC) — chỉ khi đó mới được
  -- đổi mã, và mã mới phải đúng tiền tố (sự cố 25/09: PC2609124 đổi sang Thu vẫn
  -- giữ mã PC làm kẹt dãy mã phiếu chi).
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    IF NEW.code IS NOT DISTINCT FROM OLD.code
       OR NEW.code !~ ('^' || CASE WHEN NEW.type = 'INCOME' THEN 'PT' ELSE 'PC' END || '[0-9]') THEN
      RAISE EXCEPTION 'Đổi Thu/Chi phải cấp mã phiếu mới đúng tiền tố (phiếu %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    v_cho_doi := v_cho_doi || 'code'::text;
  END IF;

  IF (to_jsonb(OLD) - v_cho_doi) IS DISTINCT FROM (to_jsonb(NEW) - v_cho_doi) THEN
    RAISE EXCEPTION 'Cửa sửa phiếu chỉ được đổi nội dung phiếu % — phát hiện đổi cột khác', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.ie_revise_scope_delta_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a01_ie_revise_scope_delta ON public.income_expenses;
CREATE TRIGGER a01_ie_revise_scope_delta
  BEFORE UPDATE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_revise_scope_delta_guard();

-- ---------------------------------------------------------------------------
-- 6. Writer.
CREATE OR REPLACE FUNCTION public.revise_pending_income_expense_v1(
  p_voucher uuid,
  p_expected_approval_version bigint,
  p_patch jsonb,
  p_items jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
  v_actor_name text;
  v_is_super boolean := public.is_super_admin();
  v_org uuid;
  v_row public.income_expenses%ROWTYPE;
  v_membership uuid;
  v_maker uuid;
  v_patch jsonb := COALESCE(p_patch, '{}'::jsonb);
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_system boolean;
  v_key text;
  v_ok boolean;
  v_prev public.income_expense_revisions%ROWTYPE;
  -- giá trị đích
  t_type text; t_code text; t_name text; t_building uuid; t_room uuid; t_tenant uuid; t_contract uuid;
  t_payer text; t_bank_account text; t_bank_name text; t_account uuid; t_attachments jsonb;
  t_notes text; t_date date; t_bra boolean;
  t_repeat_cycle text; t_repeat_count integer; t_repeat_infinity boolean; t_repeat_auto boolean;
  t_repeat_remaining integer; t_repeat_next date;
  -- hạng mục
  v_item jsonb;
  v_index integer := 0;
  v_type_id uuid;
  v_quantity numeric;
  v_unit_price_raw numeric;
  v_unit_price numeric;
  v_start date;
  v_end date;
  v_description text;
  v_type_restricted boolean;
  v_type_system_only boolean;
  v_total numeric := 0;
  v_new_items jsonb := '[]'::jsonb;
  v_old_norm jsonb;
  v_new_norm jsonb;
  v_old_money jsonb;
  v_new_money jsonb;
  v_old_type_ids uuid[];
  v_new_type_ids uuid[];
  v_items_changed boolean := false;
  v_items_money_changed boolean := false;
  -- hợp đồng
  v_contract_room uuid;
  v_contract_tenant uuid;
  -- kết quả
  v_changed text[] := '{}';
  v_money boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_revision_no integer;
  c_max_money constant numeric := 9999999999999.99;
  c_extra_whitespace constant text :=
    chr(160) || chr(173) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
    || chr(8202) || chr(8203) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(8288) || chr(12288) || chr(65279);
  c_cho_phep text[] := ARRAY['type', 'name', 'building_id', 'room_id', 'tenant_id', 'contract_id',
    'payer_name', 'receive_bank_account', 'receive_bank_name', 'account_id', 'attachments',
    'notes', 'voucher_date', 'business_result_accounting',
    'repeat_cycle', 'repeat_count', 'repeat_infinity', 'repeat_auto_approve'];
  -- Máy chủ tự tính lại hai cột này từ chu kỳ + ngày phiếu.
  c_bo_qua text[] := ARRAY['repeat_remaining', 'repeat_next_date'];
BEGIN
  -- ── 1. Tham số ────────────────────────────────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher IS NULL OR p_expected_approval_version IS NULL THEN
    RAISE EXCEPTION 'Thiếu phiếu hoặc phiên bản phiếu đang xem' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'Dữ liệu sửa phải là object' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Hạng mục phải là mảng' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Lý do sửa tối đa 1000 ký tự' USING ERRCODE = '22023';
  END IF;
  IF v_idem IS NOT NULL AND v_idem !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -'
      USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_patch) LOOP
    IF NOT (v_key = ANY (c_cho_phep) OR v_key = ANY (c_bo_qua)) THEN
      RAISE EXCEPTION 'Trường "%" không sửa được ở đây', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- ── 2. Khoá tổ chức rồi khoá phiếu ────────────────────────────────────────
  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_row FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Gọi lại cùng khoá sau khi đã ghi: trả kết quả cũ (trước CAS vì phiên bản đã tăng).
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_prev
      FROM public.income_expense_revisions r
     WHERE r.income_expense_id = p_voucher
       AND r.actor_id = v_actor
       AND r.idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'id', p_voucher, 'changed', true, 'replayed', true,
        'revision_no', v_prev.revision_no,
        'approval_version', v_row.approval_version,
        'changed_fields', to_jsonb(v_prev.changed_fields));
    END IF;
  END IF;

  -- ── 3. Trạng thái + phiên bản ─────────────────────────────────────────────
  IF v_row.approval_status <> 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Chỉ sửa được phiếu Chờ duyệt — phiếu này đang ở trạng thái %',
      CASE v_row.approval_status WHEN 'APPROVED' THEN 'Đã duyệt' WHEN 'CANCELLED' THEN 'Đã huỷ'
                                 ELSE v_row.approval_status END
      USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_row.posting_status, 'UNPOSTED') = 'POSTED' OR v_row.active_posting_id_v2 IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã ghi sổ — không sửa ở đây' USING ERRCODE = '55000';
  END IF;
  IF v_row.approval_version IS DISTINCT FROM p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác sửa — tải lại để xem thay đổi.' USING ERRCODE = 'PT409';
  END IF;

  -- ── 4. Loại phiếu sửa được ────────────────────────────────────────────────
  IF app_private.ie_flow_system_owned_v2(p_voucher) THEN
    RAISE EXCEPTION 'Phiếu thuộc luồng hệ thống — sửa ở luồng gốc' USING ERRCODE = '42501';
  END IF;
  IF v_row.system_source IS NOT NULL
     AND v_row.system_source NOT IN ('contract.commission', 'termination.refund') THEN
    RAISE EXCEPTION 'Phiếu do hệ thống sinh (%) — sửa ở luồng gốc', v_row.system_source
      USING ERRCODE = '42501';
  END IF;
  IF v_row.invoice_id IS NOT NULL OR v_row.payment_id IS NOT NULL
     OR v_row.payment_collection_id IS NOT NULL OR v_row.utility_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu gắn hoá đơn/khoản thu — sửa ở màn hoá đơn' USING ERRCODE = '42501';
  END IF;
  IF v_row.salary_staff_id IS NOT NULL OR v_row.shareholder_id IS NOT NULL
     OR v_row.profit_manager_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu lương / chia lợi nhuận — sửa ở luồng gốc' USING ERRCODE = '42501';
  END IF;
  IF v_row.handover_id IS NOT NULL OR v_row.handover_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu nằm trong phiên bàn giao tiền mặt — không sửa được' USING ERRCODE = '42501';
  END IF;
  IF v_row.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đảo của phiếu khác — không sửa được' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profit_payout_reservations x WHERE x.payout_voucher_id = p_voucher)
     OR EXISTS (SELECT 1 FROM public.reservation_deposit_settlements x WHERE x.source_voucher_id = p_voucher)
     OR EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers x WHERE x.voucher_id = p_voucher) THEN
    RAISE EXCEPTION 'Phiếu thuộc hồ sơ chia lợi nhuận / xử lý cọc giữ chỗ — sửa ở luồng gốc'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_no_engine_request_v1(p_voucher);
  v_system := v_row.system_source IS NOT NULL;

  -- ── 5. Người sửa ──────────────────────────────────────────────────────────
  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_org
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)
   ORDER BY m.id
   LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie()
     AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền sửa' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(v_row.maker_user_id, o.maker_user_id, v_row.user_id) INTO v_maker
    FROM (SELECT 1) one
    LEFT JOIN app_private.income_expense_flow_ownership o ON o.income_expense_id = p_voucher;

  -- ── 6. Giá trị đích = hiện tại, đè bằng patch ─────────────────────────────
  t_type := v_row.type;
  t_name := v_row.name;
  t_building := v_row.building_id;
  t_room := v_row.room_id;
  t_tenant := v_row.tenant_id;
  t_contract := v_row.contract_id;
  t_payer := v_row.payer_name;
  t_bank_account := v_row.receive_bank_account;
  t_bank_name := v_row.receive_bank_name;
  t_account := v_row.account_id;
  t_attachments := COALESCE(v_row.attachments, '[]'::jsonb);
  t_notes := v_row.notes;
  t_date := v_row.voucher_date;
  t_bra := v_row.business_result_accounting;
  t_repeat_cycle := COALESCE(v_row.repeat_cycle, 'NONE');
  t_repeat_count := v_row.repeat_count;
  t_repeat_infinity := v_row.repeat_infinity;
  t_repeat_auto := v_row.repeat_auto_approve;

  BEGIN
    IF v_patch ? 'type' THEN
      t_type := v_patch->>'type';
      IF t_type IS NULL OR t_type NOT IN ('INCOME', 'EXPENSE') THEN
        RAISE EXCEPTION 'Loại phiếu không hợp lệ' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_patch ? 'name' THEN
      t_name := btrim(v_patch->>'name', E' \t\n\r\f\v' || c_extra_whitespace);
      IF t_name IS NULL OR t_name = '' THEN
        RAISE EXCEPTION 'Tên phiếu không được trống' USING ERRCODE = '22023';
      END IF;
      IF char_length(t_name) > 500 THEN
        RAISE EXCEPTION 'Tên phiếu vượt quá 500 ký tự' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_patch ? 'building_id' THEN
      t_building := NULLIF(v_patch->>'building_id', '')::uuid;
      IF t_building IS NULL THEN
        RAISE EXCEPTION 'Thiếu toà nhà' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_patch ? 'room_id' THEN t_room := NULLIF(v_patch->>'room_id', '')::uuid; END IF;
    IF v_patch ? 'tenant_id' THEN t_tenant := NULLIF(v_patch->>'tenant_id', '')::uuid; END IF;
    IF v_patch ? 'contract_id' THEN t_contract := NULLIF(v_patch->>'contract_id', '')::uuid; END IF;
    IF v_patch ? 'payer_name' THEN t_payer := NULLIF(btrim(v_patch->>'payer_name'), ''); END IF;
    IF v_patch ? 'receive_bank_account' THEN
      t_bank_account := NULLIF(btrim(v_patch->>'receive_bank_account'), '');
    END IF;
    IF v_patch ? 'receive_bank_name' THEN
      t_bank_name := NULLIF(btrim(v_patch->>'receive_bank_name'), '');
    END IF;
    IF v_patch ? 'account_id' THEN t_account := NULLIF(v_patch->>'account_id', '')::uuid; END IF;
    IF v_patch ? 'attachments' THEN
      t_attachments := COALESCE(NULLIF(v_patch->'attachments', 'null'::jsonb), '[]'::jsonb);
    END IF;
    IF v_patch ? 'notes' THEN t_notes := NULLIF(v_patch->>'notes', ''); END IF;
    IF v_patch ? 'voucher_date' THEN
      t_date := NULLIF(v_patch->>'voucher_date', '')::date;
    END IF;
    IF v_patch ? 'business_result_accounting' THEN
      t_bra := (v_patch->>'business_result_accounting')::boolean;
    END IF;
    IF v_patch ? 'repeat_cycle' THEN
      t_repeat_cycle := COALESCE(NULLIF(v_patch->>'repeat_cycle', ''), 'NONE');
    END IF;
    IF v_patch ? 'repeat_count' THEN
      t_repeat_count := COALESCE(NULLIF(v_patch->>'repeat_count', '')::integer, 0);
    END IF;
    IF v_patch ? 'repeat_infinity' THEN
      t_repeat_infinity := COALESCE((v_patch->>'repeat_infinity')::boolean, false);
    END IF;
    IF v_patch ? 'repeat_auto_approve' THEN
      t_repeat_auto := COALESCE((v_patch->>'repeat_auto_approve')::boolean, true);
    END IF;
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format
      OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Dữ liệu sửa không hợp lệ (%)', SQLERRM USING ERRCODE = '22023';
  END;

  IF t_payer IS NOT NULL AND char_length(t_payer) > 255 THEN
    RAISE EXCEPTION 'Tên người nộp/nhận vượt quá 255 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_bank_account IS NOT NULL AND char_length(t_bank_account) > 255 THEN
    RAISE EXCEPTION 'Số tài khoản nhận vượt quá 255 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_bank_name IS NOT NULL AND char_length(t_bank_name) > 255 THEN
    RAISE EXCEPTION 'Tên ngân hàng nhận vượt quá 255 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_notes IS NOT NULL AND char_length(t_notes) > 5000 THEN
    RAISE EXCEPTION 'Ghi chú vượt quá 5000 ký tự' USING ERRCODE = '22023';
  END IF;
  IF t_date IS NULL OR NOT isfinite(t_date)
     OR t_date < DATE '2000-01-01' OR t_date > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(t_attachments) <> 'array'
     OR jsonb_array_length(t_attachments) > 20
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(t_attachments) x(value)
        WHERE jsonb_typeof(value) <> 'string'
           OR char_length(value #>> '{}') < 1
           OR char_length(value #>> '{}') > 2048
           OR value #>> '{}' ~ '[[:cntrl:]]'
           OR value #>> '{}' !~
                '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^[:space:]\\]*)?$'
     ) THEN
    RAISE EXCEPTION 'Ảnh chứng từ phải là tối đa 20 đường dẫn HTTPS hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF t_repeat_cycle NOT IN ('NONE', 'WEEK', 'MONTH', 'QUARTER', 'YEAR') THEN
    RAISE EXCEPTION 'Chu kỳ lặp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF t_repeat_count IS NULL OR t_repeat_count < 0 OR t_repeat_count > 1000 THEN
    RAISE EXCEPTION 'Số lần lặp phải từ 0 đến 1000' USING ERRCODE = '22023';
  END IF;
  IF t_notes IS DISTINCT FROM v_row.notes THEN
    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, t_notes);
  END IF;

  -- Lặp lại: không lặp trước và sau thì giữ nguyên mọi cột lặp; tắt lặp thì về 0;
  -- có lặp thì máy chủ tự tính lần sinh kế tiếp (phiếu gốc = kỳ #1).
  IF t_repeat_cycle = 'NONE' AND COALESCE(v_row.repeat_cycle, 'NONE') = 'NONE' THEN
    t_repeat_count := v_row.repeat_count;
    t_repeat_infinity := v_row.repeat_infinity;
    t_repeat_auto := v_row.repeat_auto_approve;
    t_repeat_remaining := v_row.repeat_remaining;
    t_repeat_next := v_row.repeat_next_date;
  ELSIF t_repeat_cycle = 'NONE' THEN
    t_repeat_count := 0;
    t_repeat_infinity := false;
    t_repeat_remaining := 0;
    t_repeat_next := NULL;
  ELSE
    t_repeat_remaining := CASE WHEN t_repeat_infinity THEN 0 ELSE t_repeat_count END;
    t_repeat_next := public.add_cycle(t_date, t_repeat_cycle, 1);
  END IF;

  -- Phiếu hoa hồng / trả khách thanh lý: khung do hệ thống dựng, không đổi được.
  IF v_system AND (
       t_type IS DISTINCT FROM v_row.type
    OR t_building IS DISTINCT FROM v_row.building_id
    OR t_room IS DISTINCT FROM v_row.room_id
    OR t_tenant IS DISTINCT FROM v_row.tenant_id
    OR t_contract IS DISTINCT FROM v_row.contract_id
    OR t_bra IS DISTINCT FROM v_row.business_result_accounting
    OR t_repeat_cycle IS DISTINCT FROM COALESCE(v_row.repeat_cycle, 'NONE')
    OR t_repeat_count IS DISTINCT FROM v_row.repeat_count
    OR t_repeat_infinity IS DISTINCT FROM v_row.repeat_infinity
    OR t_repeat_auto IS DISTINCT FROM v_row.repeat_auto_approve) THEN
    RAISE EXCEPTION 'Phiếu hoa hồng / trả khách thanh lý chỉ sửa được số tiền, sổ quỹ, ngày, người nhận, tên, ảnh — không đổi Thu/Chi, toà, phòng, khách, hợp đồng, KQKD, lặp lại'
      USING ERRCODE = '42501';
  END IF;

  -- ── 7. Quan hệ phải cùng tổ chức, đúng toà (luật của create_income_expense_v1)
  IF t_building IS DISTINCT FROM v_row.building_id THEN
    PERFORM 1 FROM public.buildings b
     WHERE b.id = t_building AND b.organization_id = v_org AND b.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Toà nhà không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF t_room IS NOT NULL AND (t_room IS DISTINCT FROM v_row.room_id OR t_building IS DISTINCT FROM v_row.building_id) THEN
    PERFORM 1 FROM public.rooms r
     WHERE r.id = t_room AND r.deleted_at IS NULL
       AND r.building_id = t_building AND r.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phòng không thuộc toà/tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF t_tenant IS NOT NULL AND t_tenant IS DISTINCT FROM v_row.tenant_id THEN
    PERFORM 1 FROM public.tenants t
     WHERE t.id = t_tenant AND t.deleted_at IS NULL AND t.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Khách thuê không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF t_contract IS NOT NULL
     AND (t_contract IS DISTINCT FROM v_row.contract_id
          OR t_room IS DISTINCT FROM v_row.room_id
          OR t_tenant IS DISTINCT FROM v_row.tenant_id
          OR t_building IS DISTINCT FROM v_row.building_id) THEN
    SELECT c.room_id, c.tenant_id INTO v_contract_room, v_contract_tenant
      FROM public.contracts c
      JOIN public.rooms r ON r.id = c.room_id AND r.deleted_at IS NULL
                         AND r.building_id = t_building AND r.organization_id = v_org
     WHERE c.id = t_contract AND c.deleted_at IS NULL AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hợp đồng không thuộc toà/tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    IF t_room IS NOT NULL AND t_room IS DISTINCT FROM v_contract_room THEN
      RAISE EXCEPTION 'Hợp đồng không khớp phòng của phiếu' USING ERRCODE = '42501';
    END IF;
    t_room := v_contract_room;
    IF v_contract_tenant IS NOT NULL THEN
      IF t_tenant IS NOT NULL AND t_tenant IS DISTINCT FROM v_contract_tenant THEN
        RAISE EXCEPTION 'Hợp đồng không khớp khách thuê của phiếu' USING ERRCODE = '42501';
      END IF;
      t_tenant := v_contract_tenant;
    ELSIF t_tenant IS NOT NULL THEN
      PERFORM 1 FROM public.contract_tenants ct
       WHERE ct.contract_id = t_contract AND ct.tenant_id = t_tenant
         AND (ct.organization_id IS NULL OR ct.organization_id = v_org);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Khách thuê không thuộc hợp đồng' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- ── 8. Quyền ──────────────────────────────────────────────────────────────
  --    Người lập (còn quyền lập phiếu ở toà đích) hoặc người có quyền sửa thu chi
  --    ở toà cũ (và toà mới nếu đổi toà). Super admin đi thẳng.
  IF NOT v_is_super THEN
    IF v_maker = v_actor THEN
      v_ok := app_private.authorize_income_expense_on_building(v_actor, v_org, 'create', t_building)
              OR app_private.ie_can_edit_money_axis_v1(v_org, t_building);
      IF NOT v_ok THEN
        RAISE EXCEPTION 'Bạn không còn quyền lập phiếu thu chi ở toà này' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT app_private.ie_can_edit_money_axis_v1(v_org, v_row.building_id) THEN
        RAISE EXCEPTION 'Chỉ người lập phiếu hoặc người có quyền sửa thu chi ở toà này mới sửa được'
          USING ERRCODE = '42501';
      END IF;
      IF t_building IS DISTINCT FROM v_row.building_id
         AND NOT app_private.ie_can_edit_money_axis_v1(v_org, t_building) THEN
        RAISE EXCEPTION 'Không có quyền sửa thu chi ở toà mới' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- Sổ quỹ mới: cùng luật với lúc lập phiếu (chủ sổ, người giữ/vận hành sổ, người
  -- biết sổ chỉ với phiếu thu). Phiếu chưa ghi sổ nên sổ cũ không cần xét.
  IF t_account IS NOT NULL
     AND (t_account IS DISTINCT FROM v_row.account_id OR t_type IS DISTINCT FROM v_row.type) THEN
    PERFORM 1 FROM public.accounts a
     WHERE a.id = t_account AND a.deleted_at IS NULL AND a.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    IF NOT (
      EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = t_account AND a.user_id = v_actor)
      OR EXISTS (
        SELECT 1
          FROM public.cashbook_possession_bindings b
          JOIN public.organization_memberships m ON m.id = b.membership_id
         WHERE b.cashbook_id = t_account
           AND b.organization_id = v_org
           AND m.user_id = v_actor
           AND m.status = 'ACTIVE'
           AND b.valid_to IS NULL
           AND (b.possession_kind IN ('CUSTODIAN', 'OPERATOR')
                OR (b.possession_kind = 'KNOWER' AND t_type = 'INCOME')))
    ) THEN
      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── 9. Hạng mục ───────────────────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(x.o ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                            (x.o->>'p')::numeric, (x.o->>'q')::numeric, x.o->>'d' NULLS FIRST), '[]'::jsonb),
         COALESCE(jsonb_agg(x.o - 'd' ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                            (x.o->>'p')::numeric, (x.o->>'q')::numeric), '[]'::jsonb),
         array_agg((x.o->>'t')::uuid ORDER BY x.o->>'t')
    INTO v_old_norm, v_old_money, v_old_type_ids
    FROM (
      SELECT jsonb_strip_nulls(jsonb_build_object(
               't', it.income_expense_type_id,
               'd', NULLIF(btrim(it.description), ''),
               'q', it.quantity,
               'p', it.unit_price,
               's', it.start_date,
               'e', it.end_date)) AS o
        FROM public.income_expense_items it
       WHERE it.income_expense_id = p_voucher
    ) x;

  IF p_items IS NOT NULL THEN
    IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
      RAISE EXCEPTION 'Phiếu phải có từ 1 đến 200 hạng mục' USING ERRCODE = '22023';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
      v_index := v_index + 1;
      IF jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION 'Hạng mục % phải là object', v_index USING ERRCODE = '22023';
      END IF;
      IF (v_item - ARRAY['income_expense_type_id', 'description', 'quantity', 'unit_price',
                         'start_date', 'end_date', 'accounting_class', 'id', 'amount']) <> '{}'::jsonb THEN
        RAISE EXCEPTION 'Hạng mục % chứa trường không được phép', v_index USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_type_id := NULLIF(v_item->>'income_expense_type_id', '')::uuid;
        v_quantity := (v_item->>'quantity')::numeric;
        v_unit_price_raw := (v_item->>'unit_price')::numeric;
        v_unit_price := round(v_unit_price_raw, 2);
        v_start := NULLIF(v_item->>'start_date', '')::date;
        v_end := NULLIF(v_item->>'end_date', '')::date;
        v_description := NULLIF(btrim(v_item->>'description'), '');
      EXCEPTION
        WHEN invalid_text_representation OR invalid_datetime_format
          OR numeric_value_out_of_range OR datetime_field_overflow THEN
          RAISE EXCEPTION 'Hạng mục % có dữ liệu không hợp lệ', v_index USING ERRCODE = '22023';
      END;
      IF v_type_id IS NULL THEN
        RAISE EXCEPTION 'Hạng mục % thiếu loại thu/chi', v_index USING ERRCODE = '22023';
      END IF;
      IF v_description IS NOT NULL AND char_length(v_description) > 1000 THEN
        RAISE EXCEPTION 'Mô tả hạng mục % vượt quá 1000 ký tự', v_index USING ERRCODE = '22023';
      END IF;
      IF v_quantity IS NULL OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_quantity < 1 OR v_quantity > 2147483647 OR v_quantity <> trunc(v_quantity) THEN
        RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên từ 1 trở lên', v_index USING ERRCODE = '22023';
      END IF;
      v_quantity := trunc(v_quantity);
      IF v_unit_price_raw IS NULL OR v_unit_price_raw::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_unit_price_raw < 0 OR v_unit_price < 0 OR v_unit_price > c_max_money THEN
        RAISE EXCEPTION 'Đơn giá hạng mục % không hợp lệ', v_index USING ERRCODE = '22023';
      END IF;
      IF v_quantity * v_unit_price > c_max_money THEN
        RAISE EXCEPTION 'Thành tiền hạng mục % vượt giới hạn', v_index USING ERRCODE = '22023';
      END IF;
      IF (v_start IS NULL) <> (v_end IS NULL) THEN
        RAISE EXCEPTION 'Hạng mục % phải có đủ ngày bắt đầu và ngày kết thúc (hoặc bỏ trống cả hai)', v_index
          USING ERRCODE = '22023';
      END IF;
      IF v_start IS NOT NULL AND (
           NOT isfinite(v_start) OR NOT isfinite(v_end)
        OR v_start < DATE '2000-01-01' OR v_end > DATE '2100-12-31'
        OR v_start > v_end OR v_end - v_start > 3660) THEN
        RAISE EXCEPTION 'Kỳ áp dụng hạng mục % phải nằm trong 2000-01-01..2100-12-31 và không quá 3660 ngày', v_index
          USING ERRCODE = '22023';
      END IF;

      SELECT t.is_restricted, t.system_only INTO v_type_restricted, v_type_system_only
        FROM public.income_expense_types t
       WHERE t.id = v_type_id
         AND lower(t.type) = CASE t_type WHEN 'INCOME' THEN 'income' ELSE 'expense' END
         AND t.organization_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Loại hạng mục % không thuộc tổ chức hoặc sai chiều thu/chi', v_index
          USING ERRCODE = '42501';
      END IF;
      -- Hạng mục chỉ-hệ-thống không được THÊM vào phiếu (giữ lại cái đang có thì được).
      IF COALESCE(v_type_system_only, false) AND NOT (v_type_id = ANY (COALESCE(v_old_type_ids, '{}'))) THEN
        RAISE EXCEPTION 'Hạng mục "%" chỉ được sinh từ hệ thống, không thêm tay',
          (SELECT name FROM public.income_expense_types WHERE id = v_type_id)
          USING ERRCODE = '0A000';
      END IF;
      IF COALESCE(v_type_restricted, false) AND NOT (v_type_id = ANY (COALESCE(v_old_type_ids, '{}')))
         AND NOT v_is_super
         AND NOT app_private.authorize_income_expense_on_building(v_actor, v_org, 'restricted_create', t_building) THEN
        RAISE EXCEPTION 'Không có quyền thêm hạng mục thu/chi hạn chế' USING ERRCODE = '42501';
      END IF;

      v_total := v_total + v_quantity * v_unit_price;
      IF v_total > c_max_money THEN
        RAISE EXCEPTION 'Tổng tiền phiếu vượt giới hạn' USING ERRCODE = '22023';
      END IF;
      v_new_items := v_new_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        't', v_type_id, 'd', v_description, 'q', v_quantity, 'p', v_unit_price,
        's', v_start, 'e', v_end)));
    END LOOP;

    SELECT COALESCE(jsonb_agg(x.o ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                              (x.o->>'p')::numeric, (x.o->>'q')::numeric, x.o->>'d' NULLS FIRST), '[]'::jsonb),
           COALESCE(jsonb_agg(x.o - 'd' ORDER BY x.o->>'t', x.o->>'s' NULLS FIRST, x.o->>'e' NULLS FIRST,
                              (x.o->>'p')::numeric, (x.o->>'q')::numeric), '[]'::jsonb),
           array_agg((x.o->>'t')::uuid ORDER BY x.o->>'t')
      INTO v_new_norm, v_new_money, v_new_type_ids
      FROM jsonb_array_elements(v_new_items) x(o);

    v_items_changed := v_new_norm IS DISTINCT FROM v_old_norm;
    v_items_money_changed := v_new_money IS DISTINCT FROM v_old_money;

    IF v_system AND v_new_type_ids IS DISTINCT FROM v_old_type_ids THEN
      RAISE EXCEPTION 'Phiếu hoa hồng / trả khách thanh lý chỉ sửa được số tiền của các hạng mục đang có — không thêm, bớt hay đổi loại hạng mục'
        USING ERRCODE = '42501';
    END IF;
  ELSIF t_type IS DISTINCT FROM v_row.type THEN
    RAISE EXCEPTION 'Đổi Thu/Chi phải chọn lại hạng mục cho đúng chiều' USING ERRCODE = '22023';
  END IF;

  -- ── 10. Có gì đổi thật ────────────────────────────────────────────────────
  IF t_type IS DISTINCT FROM v_row.type THEN v_changed := v_changed || 'type'::text; END IF;
  IF t_name IS DISTINCT FROM v_row.name THEN v_changed := v_changed || 'name'::text; END IF;
  IF t_building IS DISTINCT FROM v_row.building_id THEN v_changed := v_changed || 'building_id'::text; END IF;
  IF t_room IS DISTINCT FROM v_row.room_id THEN v_changed := v_changed || 'room_id'::text; END IF;
  IF t_tenant IS DISTINCT FROM v_row.tenant_id THEN v_changed := v_changed || 'tenant_id'::text; END IF;
  IF t_contract IS DISTINCT FROM v_row.contract_id THEN v_changed := v_changed || 'contract_id'::text; END IF;
  IF t_payer IS DISTINCT FROM v_row.payer_name THEN v_changed := v_changed || 'payer_name'::text; END IF;
  IF t_bank_account IS DISTINCT FROM v_row.receive_bank_account THEN
    v_changed := v_changed || 'receive_bank_account'::text;
  END IF;
  IF t_bank_name IS DISTINCT FROM v_row.receive_bank_name THEN
    v_changed := v_changed || 'receive_bank_name'::text;
  END IF;
  IF t_account IS DISTINCT FROM v_row.account_id THEN v_changed := v_changed || 'account_id'::text; END IF;
  IF t_attachments IS DISTINCT FROM COALESCE(v_row.attachments, '[]'::jsonb) THEN
    v_changed := v_changed || 'attachments'::text;
  END IF;
  IF t_notes IS DISTINCT FROM v_row.notes THEN v_changed := v_changed || 'notes'::text; END IF;
  IF t_date IS DISTINCT FROM v_row.voucher_date THEN v_changed := v_changed || 'voucher_date'::text; END IF;
  IF t_bra IS DISTINCT FROM v_row.business_result_accounting THEN
    v_changed := v_changed || 'business_result_accounting'::text;
  END IF;
  IF t_repeat_cycle IS DISTINCT FROM COALESCE(v_row.repeat_cycle, 'NONE')
     OR t_repeat_count IS DISTINCT FROM v_row.repeat_count
     OR t_repeat_infinity IS DISTINCT FROM v_row.repeat_infinity
     OR t_repeat_auto IS DISTINCT FROM v_row.repeat_auto_approve THEN
    v_changed := v_changed || 'repeat'::text;
  END IF;
  IF v_items_changed THEN v_changed := v_changed || 'items'::text; END IF;

  IF cardinality(v_changed) = 0 THEN
    RETURN jsonb_build_object(
      'id', p_voucher, 'changed', false,
      'approval_version', v_row.approval_version,
      'revision_no', (SELECT max(r.revision_no) FROM public.income_expense_revisions r
                       WHERE r.income_expense_id = p_voucher),
      'changed_fields', '[]'::jsonb);
  END IF;

  -- Trục tiền phải có lý do (chủ chốt 25/09: số tiền, hạng mục, loại, sổ quỹ, toà).
  -- Chọn sổ quỹ LẦN ĐẦU cho phiếu chưa có sổ (hộp Duyệt vẫn làm) không phải đổi sổ.
  v_money := v_changed && ARRAY['type', 'building_id', 'business_result_accounting']
             OR ('account_id' = ANY (v_changed) AND v_row.account_id IS NOT NULL)
             OR v_items_money_changed;
  IF v_money AND (v_reason IS NULL OR char_length(v_reason) < 8) THEN
    RAISE EXCEPTION 'Đổi số tiền, hạng mục, loại, sổ quỹ hoặc toà phải ghi lý do (ít nhất 8 ký tự).'
      USING ERRCODE = '22023';
  END IF;

  -- Kỳ đã đóng ở vị trí CŨ (sổ chốt, phiên bàn giao, tháng lợi nhuận); vị trí MỚI do
  -- trigger khoá kỳ kiểm khi ghi.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'sửa');

  -- ── 11. Ghi ───────────────────────────────────────────────────────────────
  v_before := app_private.ie_revision_snapshot_v1(p_voucher);

  -- Đổi Thu ↔ Chi: cấp mã MỚI đúng tiền tố (PT/PC) từ bộ đếm chung của tổ chức;
  -- số cũ bỏ, không tái dùng. Giữ mã PC trên phiếu thu từng làm bộ đếm cũ cấp
  -- trùng và kẹt cả dãy phiếu chi (sự cố PC2609124, 25/09/2026). Cấp ở đây — sau
  -- mọi bước kiểm — nên lần sửa bị từ chối không đốt số (cùng một transaction).
  IF t_type IS DISTINCT FROM v_row.type THEN
    t_code := app_private.next_voucher_code_v1(v_org, t_type);
    v_changed := v_changed || 'code'::text;
  ELSE
    t_code := v_row.code;
  END IF;

  PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'REVISE');

  UPDATE public.income_expenses ie
     SET type = t_type,
         code = t_code,
         name = t_name,
         building_id = t_building,
         room_id = t_room,
         tenant_id = t_tenant,
         contract_id = t_contract,
         payer_name = t_payer,
         receive_bank_account = t_bank_account,
         receive_bank_name = t_bank_name,
         account_id = t_account,
         attachments = t_attachments,
         notes = t_notes,
         voucher_date = t_date,
         business_result_accounting = t_bra,
         repeat_cycle = t_repeat_cycle,
         repeat_count = t_repeat_count,
         repeat_infinity = t_repeat_infinity,
         repeat_auto_approve = t_repeat_auto,
         repeat_remaining = t_repeat_remaining,
         repeat_next_date = t_repeat_next,
         approval_version = ie.approval_version + 1,
         updated_at = now()
   WHERE ie.id = p_voucher;

  IF v_items_changed THEN
    DELETE FROM public.income_expense_items it WHERE it.income_expense_id = p_voucher;
    -- Giữ đúng thứ tự người dùng nhập: mỗi dòng một mốc created_at tăng dần.
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_new_items) LOOP
      INSERT INTO public.income_expense_items
        (income_expense_id, income_expense_type_id, description, quantity, unit_price,
         start_date, end_date, organization_id, created_at)
      VALUES
        (p_voucher, (v_item->>'t')::uuid, v_item->>'d', (v_item->>'q')::numeric,
         (v_item->>'p')::numeric, (v_item->>'s')::date, (v_item->>'e')::date, v_org, clock_timestamp());
    END LOOP;
  END IF;

  PERFORM app_private.end_ie_flex_write_v1(p_voucher);

  v_after := app_private.ie_revision_snapshot_v1(p_voucher);

  SELECT COALESCE(max(r.revision_no), 0) + 1 INTO v_revision_no
    FROM public.income_expense_revisions r
   WHERE r.income_expense_id = p_voucher;

  INSERT INTO public.income_expense_revisions
    (organization_id, income_expense_id, revision_no, kind, actor_id, actor_name, reason,
     changed_fields, before_snapshot, after_snapshot, idempotency_key)
  VALUES
    (v_org, p_voucher, v_revision_no, 'EDIT_PENDING', v_actor, COALESCE(v_actor_name, 'Người dùng'),
     v_reason, v_changed, v_before, v_after, v_idem);

  PERFORM app_private.append_income_expense_event_v1(
    v_org, p_voucher, 'REVISED', v_actor, v_actor_name, 'UNAPPROVED', 'UNAPPROVED',
    left('Sửa phiếu chờ duyệt lần ' || v_revision_no || ': ' || array_to_string(v_changed, ', ')
         || COALESCE(' — ' || v_reason, ''), 1000));

  RETURN jsonb_build_object(
    'id', p_voucher,
    'changed', true,
    'revision_no', v_revision_no,
    'approval_version', v_row.approval_version + 1,
    'changed_fields', to_jsonb(v_changed));
END
$function$;

REVOKE ALL ON FUNCTION public.revise_pending_income_expense_v1(uuid, bigint, jsonb, jsonb, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revise_pending_income_expense_v1(uuid, bigint, jsonb, jsonb, text, text)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Duyệt có kiểm phiên bản (chủ chốt: "sửa chen giữa thì bắt tải lại").
--    Nút Duyệt đang gọi approve_income_expense_v1 / approve_voucher — hai hàm này
--    không nhận phiên bản, nên người duyệt có thể duyệt một nội dung vừa bị sửa
--    mà chưa xem. Hàm này khoá tổ chức → khoá phiếu (cùng thứ tự với writer sửa)
--    rồi mới so approval_version, sau đó đi đúng đường duyệt hiện hành.
CREATE OR REPLACE FUNCTION public.approve_pending_income_expense_checked_v1(
  p_voucher uuid,
  p_expected_approval_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_org uuid;
  v_row public.income_expenses%ROWTYPE;
BEGIN
  IF app_private.current_uid_v1() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher IS NULL OR p_expected_approval_version IS NULL THEN
    RAISE EXCEPTION 'Thiếu phiếu hoặc phiên bản phiếu đang xem' USING ERRCODE = '22023';
  END IF;

  -- Bậc 1 của thang duyệt: cặp phiếu bỏ cọc duyệt CẢ CẶP qua cửa chuyên trách
  -- (duyệt lệch một chân là kẹt vĩnh viễn). Rẽ trước mọi khoá dòng, như
  -- approve_income_expense_v2. Cặp này không sửa được nên không có phiên bản để so.
  IF EXISTS (
    SELECT 1 FROM app_private.termination_forfeit_authorizations f
     WHERE f.revenue_voucher_id = p_voucher OR f.offset_voucher_id = p_voucher
  ) THEN
    PERFORM public.set_termination_forfeit_status_v1(p_voucher, 'APPROVED');
    RETURN jsonb_build_object('id', p_voucher, 'approved', true, 'already', false, 'mode', 'FORFEIT_PAIR');
  END IF;

  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_row FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.approval_status = 'APPROVED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'approved', true, 'already', true);
  END IF;
  IF v_row.approval_status <> 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Phiếu đã huỷ — không thể duyệt' USING ERRCODE = '55000';
  END IF;
  IF v_row.approval_version IS DISTINCT FROM p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được sửa — tải lại để xem thay đổi trước khi duyệt.' USING ERRCODE = 'PT409';
  END IF;

  -- Bậc 2 (phiếu thuộc luồng) / bậc 3 (phiếu cũ) — cùng phép phân loại mà
  -- approve_income_expense_v1 dùng để trả "tín hiệu fallback".
  IF app_private.is_income_expense_flow_owned(p_voucher) THEN
    PERFORM public.approve_income_expense_v1(p_voucher);
  ELSE
    PERFORM public.approve_voucher(p_voucher);
  END IF;

  RETURN jsonb_build_object('id', p_voucher, 'approved', true, 'already', false, 'mode', 'VOUCHER');
END
$function$;

REVOKE ALL ON FUNCTION public.approve_pending_income_expense_checked_v1(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_pending_income_expense_checked_v1(uuid, bigint)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Câu báo cũ "phiếu canonical không sửa được: Huỷ rồi Tạo bản sao" hết đúng:
--    phiếu Chờ duyệt nay sửa được. Chỉ đổi đúng câu đó, thân còn lại y bản prod
--    (md5 c80b22a0…).
CREATE OR REPLACE FUNCTION public.approve_income_expense_v1(p_voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_row public.income_expenses%rowtype;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_voucher_id and deleted_at is null
   for update;
  if not found then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  -- Row legacy → tín hiệu fallback (hook chuyển sang approve_voucher legacy).
  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  if v_row.approval_status = 'APPROVED' then
    return; -- idempotent no-op
  end if;

  -- t5_26: phiếu đang chờ engine → chỉ quyết qua màn Chờ duyệt
  perform app_private.assert_no_engine_request_v1(v_row.id);

  if v_row.approval_status = 'CANCELLED' then
    -- Phương án A: phiếu huỷ là terminal — dùng nút "Tạo bản sao".
    raise exception 'Phiếu đã huỷ — không thể duyệt. Hãy dùng "Tạo bản sao" để lập phiếu mới.';
  end if;

  -- Parity legacy: phải có sổ quỹ trước khi duyệt.
  if v_row.account_id is null then
    raise exception 'Phiếu chưa có sổ quỹ — bấm Sửa phiếu, chọn sổ quỹ rồi mới duyệt được.';
  end if;

  -- Permission parity với public.approve_voucher.
  if not (
    v_row.user_id = v_actor
    or public.is_super_admin()
    or (v_row.building_id is not null
        and public.can_do_on_building('income_expenses', 'approve', v_row.building_id))
  ) then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'APPROVED');

  update public.income_expenses
     set approval_status = 'APPROVED',
         approved_by = v_actor,
         approved_at = now()
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'approve transition affected % rows (expected 1)', v_rows
      using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'APPROVED', v_actor, v_actor_name,
    v_row.approval_status, 'APPROVED', 'Duyệt qua approve_income_expense_v1');
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Nghiệm thu.
DO $nghiem_thu$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'app_private.ie_flex_writer_xids'::regclass
     AND c.conname = 'ie_flex_writer_xids_scope_chk';
  IF v_def IS NULL OR position('''REVISE''' IN v_def) = 0 OR position('''STOP_RECURRING''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: scope REVISE chua co trong ie_flex_writer_xids_scope_chk';
  END IF;

  v_def := pg_get_functiondef('app_private.is_income_expense_flow_owned(uuid)'::regprocedure);
  IF v_def !~ 'REVISE' OR v_def !~ 'pg_current_xact_id_if_assigned' THEN
    RAISE EXCEPTION 'nghiem_thu: is_income_expense_flow_owned chua nhuong cua REVISE';
  END IF;
  IF md5(pg_get_functiondef('app_private.guard_income_expense_owned_payload()'::regprocedure))
     <> 'fb01ae8c9de7b283d19ade8195eba726' THEN
    RAISE EXCEPTION 'nghiem_thu: guard niem phong da ghim bi doi';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.income_expenses'::regclass
       AND t.tgname = 'a01_ie_revise_scope_delta'
       AND t.tgfoid = 'app_private.ie_revise_scope_delta_guard()'::regprocedure
       AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'nghiem_thu: thieu trigger a01_ie_revise_scope_delta';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.income_expense_revisions'::regclass) THEN
    RAISE EXCEPTION 'nghiem_thu: income_expense_revisions chua bat RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.income_expense_revisions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.income_expense_revisions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.income_expense_revisions', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.income_expense_revisions', 'SELECT')
     OR has_table_privilege('anon', 'public.income_expense_revisions', 'SELECT') THEN
    RAISE EXCEPTION 'nghiem_thu: quyen bang income_expense_revisions sai';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: quyen goi revise_pending_income_expense_v1 sai';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.ie_revision_snapshot_v1(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.ie_revise_scope_delta_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: ham noi bo dang mo cho authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.approve_pending_income_expense_checked_v1(uuid,bigint)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.approve_pending_income_expense_checked_v1(uuid,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: quyen goi approve_pending_income_expense_checked_v1 sai';
  END IF;
  IF pg_get_functiondef('public.approve_income_expense_v1(uuid)'::regprocedure) ~ 'canonical không sửa được' THEN
    RAISE EXCEPTION 'nghiem_thu: approve_income_expense_v1 con cau bao cu';
  END IF;
  -- Đổi Thu/Chi phải cấp mã mới đúng tiền tố (hàm cấp số chung từ migration mã phiếu).
  IF to_regprocedure('app_private.next_voucher_code_v1(uuid,text)') IS NULL
     OR pg_get_functiondef('public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)'::regprocedure)
        !~ 'app_private\.next_voucher_code_v1\(v_org, t_type\)' THEN
    RAISE EXCEPTION 'nghiem_thu: doi Thu/Chi chua cap ma phieu moi';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
