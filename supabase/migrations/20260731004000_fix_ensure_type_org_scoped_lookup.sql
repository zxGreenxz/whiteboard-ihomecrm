-- =====================================================================
-- SỬA BUG PRODUCTION: `confirm_cash_handover` HỎNG VỚI MỌI NGƯỜI
--
-- Phát hiện khi probe nghi thức bàn giao thật (bọc transaction, cuộn lại 100%)
-- để chứng minh trigger E6a của PA4 không làm hỏng writer tiền. Trigger vô can —
-- lỗi nổ ở `confirm_cash_handover` dòng 70, TRƯỚC trigger:
--
--   23505 duplicate key value violates unique constraint
--         "income_expense_types_org_side_normalized_name_uq"
--   Key (organization_id, lower(btrim(type)), normalize_income_expense_type_name(name))
--       = (aaaa0000-…0001, expense, ban giao tien mat) already exists.
--
-- NGUYÊN NHÂN GỐC — hai tầng lệch phạm vi:
--   · `_termination_ensure_type` TRA CỨU theo `user_id = p_user_id`
--     (loại phiếu CỦA NGƯỜI ĐANG THAO TÁC),
--   · nhưng unique index CHẶN theo `organization_id` (loại phiếu CỦA TỔ CHỨC).
--   ⇒ loại phiếu đã tồn tại trong org mà do NGƯỜI KHÁC đứng tên thì tra không
--     thấy → nhảy xuống INSERT → đâm vào index → 23505.
--
-- Đo trên prod (org thật `iHome CRM`):
--   'Bàn giao tiền mặt'       (expense) — chủ sở hữu B.Huy
--   'Nhận bàn giao tiền mặt'  (income)  — chủ sở hữu NATHAN
-- `confirm_cash_handover` cần CẢ HAI. KHÔNG một ai đứng tên cả hai ⇒ mọi người
-- trong org đều hỏng. Phiên bàn giao gần nhất là 22/07; từ đó tới nay không ai
-- xác nhận được phiên nào. Đây cũng là lý do E6a của PA4 sẽ không bao giờ bắn
-- nếu không vá: nó neo vào nhịp PENDING → CONFIRMED.
--
-- CÁCH VÁ: cho tra cứu ĐI THEO ĐÚNG PHẠM VI MÀ INDEX CHẶN — org + type + tên
-- chuẩn hoá — rồi mới lùi về nhánh cũ (theo user) cho những dòng còn
-- `organization_id IS NULL`. Không xoá, không gộp, không đổi dữ liệu; chỉ thôi
-- INSERT trùng. Đo trước khi vá: KHÔNG có bộ (org, type, tên chuẩn hoá) nào có
-- quá một dòng, nên nhánh mới luôn tìm được đúng một dòng.
--
-- 7 hàm gọi tới nó, đều đụng tiền: _ensure_initial_deposit_voucher ·
-- confirm_cash_handover · create_opening_adjustment · ensure_room_deposit_type ·
-- pay_utility_bill · terminate_contract_forfeit_impl ·
-- terminate_contract_move_out_impl. Với cả 7, hành vi đổi theo đúng một hướng:
-- trước đây 23505 thì nay dùng lại loại phiếu sẵn có của tổ chức.
--
-- Thân hàm dưới đây là bản DUMP TỪ PROD hôm nay, chỉ thay khối SELECT tra cứu.
-- Có ASSERT md5 tiền ảnh: thân hàm khác dự kiến thì DỪNG, không vá bừa
-- (án lệ: thân hàm prod trôi khỏi file migration).
-- =====================================================================

BEGIN;

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public._termination_ensure_type(uuid,text,text)'::regprocedure))
    INTO v_md5;
  IF position('lower(name) = lower(p_name)' IN
      pg_get_functiondef('public._termination_ensure_type(uuid,text,text)'::regprocedure)) = 0 THEN
    IF position('normalize_income_expense_type_name' IN
        pg_get_functiondef('public._termination_ensure_type(uuid,text,text)'::regprocedure)) > 0 THEN
      RAISE NOTICE 'Đã vá trước đó (md5=%), bỏ qua', v_md5;
    ELSE
      RAISE EXCEPTION
        'Thân _termination_ensure_type không khớp mẫu đã đo (md5=%) — DỪNG thay vì vá bừa', v_md5;
    END IF;
  ELSE
    RAISE NOTICE 'Tiền ảnh khớp mẫu, md5=%', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._termination_ensure_type(
  p_user_id uuid, p_type text, p_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_org uuid;
begin
  -- org của người thao tác: 1 membership → dùng luôn; nhiều → ưu tiên org
  -- mà user giữ role "Chủ sở hữu tổ chức" (owner thật thuộc cả demo).
  select min(m.organization_id::text)::uuid into v_org
    from organization_memberships m
   where m.user_id = p_user_id and m.status = 'ACTIVE';
  if (select count(distinct m.organization_id) from organization_memberships m
       where m.user_id = p_user_id and m.status = 'ACTIVE') > 1 then
    select rb.organization_id into v_org
      from role_bindings rb
      join organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = p_user_id and m.status = 'ACTIVE'
      join organization_roles r on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     limit 1;
  end if;

  -- (1) TRA THEO ĐÚNG PHẠM VI MÀ UNIQUE INDEX CHẶN.
  --     income_expense_types_org_side_normalized_name_uq =
  --       (organization_id, lower(btrim(type)), normalize_income_expense_type_name(name))
  --     Tra theo user_id như bản cũ là tra hẹp hơn chỗ bị chặn ⇒ loại phiếu do
  --     người KHÁC trong cùng org đứng tên thì tra không thấy, INSERT xuống là
  --     23505. Đúng lỗi làm confirm_cash_handover chết với mọi người.
  if v_org is not null then
    select t.id into v_id
      from income_expense_types t
     where t.organization_id = v_org
       and lower(btrim(t.type)) = lower(btrim(p_type))
       and normalize_income_expense_type_name(t.name)
           = normalize_income_expense_type_name(p_name)
     limit 1;

    if v_id is not null then
      update income_expense_types
         set force_approval = true
       where id = v_id and force_approval = false;
      return v_id;
    end if;
  end if;

  -- (2) Nhánh cũ, giữ lại cho những dòng còn organization_id IS NULL (chưa được
  --     gắn org) — index không chặn chúng nên vẫn phải tự tìm theo người tạo.
  select id into v_id
    from income_expense_types
   where user_id = p_user_id
     and lower(name) = lower(p_name)
     and lower(type) = lower(p_type)
   limit 1;

  if v_id is not null then
    update income_expense_types
       set force_approval = true,
           organization_id = coalesce(organization_id, v_org)
     where id = v_id and (force_approval = false or organization_id is null);
    return v_id;
  end if;

  insert into income_expense_types (user_id, organization_id, type, name, description, force_approval)
  values (p_user_id, v_org, lower(p_type), p_name,
          'Tự tạo khi thanh lý hợp đồng', true)
  returning id into v_id;

  return v_id;
end;
$function$;

-- CREATE OR REPLACE giữ nguyên ACL cũ (không phải DROP+CREATE nên không hứng
-- default privileges), nhưng khẳng định lại cho chắc: hàm này chỉ được gọi từ
-- các writer SECURITY DEFINER khác, KHÔNG phơi ra PostgREST.
REVOKE ALL ON FUNCTION public._termination_ensure_type(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._termination_ensure_type(uuid, text, text) IS
  'Bảo đảm có loại thu/chi hệ thống. Tra theo (organization_id, type, tên chuẩn hoá) — ĐÚNG phạm vi mà income_expense_types_org_side_normalized_name_uq chặn. Bản cũ tra theo user_id nên loại phiếu do người khác trong cùng org đứng tên thì tra không thấy rồi INSERT đâm vào index (23505) — đã làm confirm_cash_handover chết với MỌI người trong org thật.';

COMMIT;
