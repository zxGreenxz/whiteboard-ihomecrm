-- =============================================================================
-- Vai chủ sở hữu: 4 hàm còn nhận diện bằng TÊN VAI → neo sang system_key
--
-- I3.2, plan rà soát 15/09/2026.
--
-- ------------------------- ĐIỀU PLAN ĐỀ XUẤT MÀ KHÔNG LÀM ĐƯỢC -------------
-- Plan viết: UPDATE organization_roles SET system_key='TENANT_OWNER'
--            WHERE name='Chủ công ty'.
-- Đo production 15/09/2026 (read-only) cho thấy câu đó KHÔNG chạy được, và
-- vấn đề nó định chữa thì đã chữa xong bằng đường khác:
--
--   org "iHome CRM"       : "Chủ công ty"        system_key NULL, 223 quyền, 1 binding
--                           "Chủ sở hữu tổ chức" system_key TENANT_OWNER, 2 binding
--   org "iHome CRM (Demo)": "Chủ công ty"        system_key TENANT_OWNER, 223 quyền
--
--   • Index duy nhất organization_roles_system_key_uidx chốt MỖI ORG ĐÚNG MỘT
--     vai cho mỗi system_key. Gán TENANT_OWNER cho "Chủ công ty" của iHome CRM
--     là 23505 — đúng đường mà 20260831160000 đã thử và bị chặn.
--   • 20260831160000 đã giải bằng cách hợp thiết kế: CHỦ THẬT
--     (0520169e-0860-4b4e-a603-675c8aa245aa) nhận thêm role_binding tới vai
--     TENANT_OWNER sẵn có. Đo lại hôm nay: app_private.is_org_owner_v1 đã TRUE
--     cho chính chủ. Phần "không lọt is_org_owner_v1" của I3.2 KHÔNG còn hở.
--   • Migration đó còn có selfcheck cấm đổi system_key của vai "Chủ công ty".
--     Làm ngược lại ở đây là lật một quyết định đã cân nhắc, không phải vá lỗi.
--
-- Nên file này CHỈ làm phần còn lại và là phần thật sự chưa ai làm.
--
-- ------------------------- PHẦN THẬT SỰ CÒN HỞ ------------------------------
-- COMMENT của app_private.guard_system_role_identity() đã ghi từ lâu: "ngoài
-- is_org_owner_v1 (đã neo vào system_key) còn 5 hàm khác vẫn so theo chuỗi
-- 'Chủ sở hữu tổ chức'". Quét production 15/09 còn ĐÚNG 4 (hai hàm openclaw
-- trong danh sách cũ đã biến mất cùng đợt xoá OpenClaw 30/08):
--
--   public._termination_ensure_type            — ĐƯỜNG TIỀN (thanh lý hợp đồng)
--   public.get_ie_auto_approve_threshold_v1    — đọc ngưỡng tự duyệt
--   public.set_ie_auto_approve_threshold_v1    — ĐẶT ngưỡng tự duyệt (cửa quyền)
--   public.set_membership_status_v1            — đình chỉ/thu hồi thành viên
--
-- Tên vai là text TỰ DO: người dùng đổi tên vai trong Cài đặt là bốn hàm này
-- lập tức coi như tổ chức không còn chủ. Hôm nay guard_system_role_identity
-- chặn việc đổi tên chỉ để giữ bốn hàm này sống — tức là một ràng buộc giao
-- diện đang gánh cho một chỗ nhận diện sai.
--
-- ĐO TẬP NGƯỜI LỌT CỬA, TRƯỚC VÀ SAU (production, read-only 15/09/2026):
--   theo tên  →  1 cặp (org, user)
--   theo key  →  3 cặp
--   mất đi: 0     thêm: 2  (đều ở org Demo, nơi vai chủ tên là "Chủ công ty"
--                           và MANG system_key TENANT_OWNER)
-- Hai người thêm chính là chủ công ty Demo — họ đang bị bốn hàm này coi như
-- người ngoài dù giữ đúng vai chủ. Không ai mất quyền.
--
-- Bốn hàm được chép nguyên từ pg_get_functiondef trên production 15/09/2026,
-- CHỈ đổi mệnh đề nhận diện vai. Không đụng chữ nào khác.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. _termination_ensure_type — chọn org của người thao tác khi họ nhiều org.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._termination_ensure_type(p_user_id uuid, p_type text, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_org uuid;
begin
  -- org của người thao tác: 1 membership → dùng luôn; nhiều → ưu tiên org mà
  -- user giữ vai CHỦ (system_key TENANT_OWNER; owner thật thuộc cả demo).
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
      join organization_roles r on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
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

-- ---------------------------------------------------------------------------
-- 2. get_ie_auto_approve_threshold_v1 — đọc ngưỡng tự duyệt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ie_auto_approve_threshold_v1()
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_cnt int; v_owner_org uuid;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select count(distinct m.organization_id), min(m.organization_id::text)::uuid
    into v_cnt, v_org
    from public.organization_memberships m
   where m.user_id = v_actor and m.status = 'ACTIVE';
  if coalesce(v_cnt,0) = 0 then raise exception 'Không thuộc tổ chức nào' using errcode='42501'; end if;
  if v_cnt > 1 then
    select rb.organization_id into v_owner_org
      from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;
  return (select c.threshold from app_private.ie_auto_approve_config c
           where c.organization_id = v_org);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. set_ie_auto_approve_threshold_v1 — ĐẶT ngưỡng tự duyệt. Đây là CỬA QUYỀN:
--    mệnh đề nhận diện vai vừa chọn org vừa quyết định ai được bấm.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_ie_auto_approve_threshold_v1(p_threshold numeric)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_cnt int; v_owner_org uuid; v_is_owner boolean;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_threshold is not null and (p_threshold <= 0 or round(p_threshold,2) <> p_threshold) then
    raise exception 'Ngưỡng không hợp lệ (phải > 0)' using errcode='22023';
  end if;
  select count(distinct m.organization_id), min(m.organization_id::text)::uuid
    into v_cnt, v_org
    from public.organization_memberships m
   where m.user_id = v_actor and m.status = 'ACTIVE';
  if coalesce(v_cnt,0) = 0 then raise exception 'Không thuộc tổ chức nào' using errcode='42501'; end if;
  if v_cnt > 1 then
    select rb.organization_id into v_owner_org
      from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;

  select exists (
    select 1 from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
     where rb.organization_id = v_org
  ) into v_is_owner;
  if not (coalesce(v_is_owner,false) or coalesce(public.is_super_admin(),false)) then
    raise exception 'Chỉ Chủ sở hữu tổ chức được đặt ngưỡng tự duyệt' using errcode='42501';
  end if;

  insert into app_private.ie_auto_approve_config (organization_id, threshold, updated_by, updated_at)
  values (v_org, p_threshold, v_actor, now())
  on conflict (organization_id)
  do update set threshold = excluded.threshold,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at;

  return json_build_object('organization_id', v_org, 'threshold', p_threshold);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. set_membership_status_v1 — đình chỉ/thu hồi thành viên. Ba chỗ so tên:
--    chọn org được phép thao tác, đếm chủ còn lại, và kiểm đối tượng có phải
--    chủ cuối cùng không. Cả ba đổi cùng lúc, nếu không thì đếm một kiểu mà
--    kiểm một kiểu.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_membership_status_v1(p_user_id uuid, p_status text, p_reason text DEFAULT NULL::text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_memb uuid; v_owner_cnt int; v_sa_deleted int := 0;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_status not in ('ACTIVE','SUSPENDED','REVOKED') then
    raise exception 'Trạng thái không hợp lệ (ACTIVE/SUSPENDED/REVOKED)' using errcode='22023';
  end if;
  if p_user_id = v_actor then
    raise exception 'Không thể tự đổi trạng thái của chính mình' using errcode='42501';
  end if;

  -- org: nơi người thao tác giữ vai CHỦ (system_key TENANT_OWNER) và đối tượng
  -- là thành viên.
  select m.organization_id, m.id into v_org, v_memb
    from public.organization_memberships m
   where m.user_id = p_user_id
     and (
       public.is_super_admin()
       or exists (
         select 1 from public.role_bindings rb
           join public.organization_memberships om
             on om.id = rb.membership_id and om.organization_id = rb.organization_id
            and om.user_id = v_actor and om.status = 'ACTIVE'
           join public.organization_roles r
             on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
          where rb.organization_id = m.organization_id
            and (rb.valid_to is null or rb.valid_to > now())
       )
     )
   order by (m.status = 'ACTIVE') desc
   limit 1;
  if v_memb is null then
    raise exception 'Không có quyền đổi trạng thái thành viên này' using errcode='42501';
  end if;

  -- không hạ cấp người chủ sở hữu cuối cùng
  if p_status <> 'ACTIVE' then
    select count(*) into v_owner_cnt
      from public.role_bindings rb
      join public.organization_memberships om
        on om.id = rb.membership_id and om.organization_id = rb.organization_id
       and om.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
     where rb.organization_id = v_org
       and (rb.valid_to is null or rb.valid_to > now())
       and om.user_id <> p_user_id;
    if v_owner_cnt = 0 and exists (
      select 1 from public.role_bindings rb
        join public.organization_memberships om
          on om.id = rb.membership_id and om.organization_id = rb.organization_id
         and om.user_id = p_user_id
        join public.organization_roles r
          on r.id = rb.role_id and r.system_key = 'TENANT_OWNER'
       where rb.organization_id = v_org and (rb.valid_to is null or rb.valid_to > now())
    ) then
      raise exception 'Không thể đình chỉ/thu hồi CHỦ SỞ HỮU CUỐI CÙNG của tổ chức' using errcode='42501';
    end if;
  end if;

  update public.organization_memberships
     set status = p_status,
         revoked_at = case when p_status = 'REVOKED' then now() else null end,
         activated_at = case when p_status = 'ACTIVE' then coalesce(activated_at, now()) else activated_at end,
         version = version + 1
   where id = v_memb;

  -- THU HỒI: gỡ luôn assignment legacy (trigger a80 đóng role_binding).
  if p_status = 'REVOKED' then
    delete from public.staff_assignments
     where staff_id = p_user_id and organization_id = v_org;
    get diagnostics v_sa_deleted = row_count;
  end if;

  update public.organizations
     set authorization_version = authorization_version + 1
   where id = v_org;

  return json_build_object('user_id', p_user_id, 'organization_id', v_org,
                           'status', p_status, 'assignments_removed', v_sa_deleted,
                           'reason', nullif(btrim(coalesce(p_reason,'')),''));
end;
$function$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
--
--   (a) Không hàm nào trong bốn hàm còn so theo tên vai.
--   (b) Tập (org, user) lọt cửa chủ theo system_key phải PHỦ tập theo tên — tức
--       không ai mất quyền vì lần đổi này. Đo trên dữ liệu thật lúc apply, chứ
--       không tin con số đã đo lúc soạn file.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten int; v_mat int;
BEGIN
  SELECT count(*) INTO v_ten
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_termination_ensure_type', 'get_ie_auto_approve_threshold_v1',
                       'set_ie_auto_approve_threshold_v1', 'set_membership_status_v1')
     AND p.prosrc LIKE '%r.name =%';
  IF v_ten <> 0 THEN
    RAISE EXCEPTION 'Con % ham nhan dien vai theo TEN. DUNG.', v_ten;
  END IF;

  SELECT count(*) INTO v_mat
    FROM (
      SELECT rb.organization_id, om.user_id
        FROM public.role_bindings rb
        JOIN public.organization_memberships om
          ON om.id = rb.membership_id AND om.organization_id = rb.organization_id
        JOIN public.organization_roles r ON r.id = rb.role_id
       WHERE r.name = 'Chủ sở hữu tổ chức' AND rb.valid_to IS NULL
      EXCEPT
      SELECT rb.organization_id, om.user_id
        FROM public.role_bindings rb
        JOIN public.organization_memberships om
          ON om.id = rb.membership_id AND om.organization_id = rb.organization_id
        JOIN public.organization_roles r ON r.id = rb.role_id
       WHERE r.system_key = 'TENANT_OWNER' AND rb.valid_to IS NULL
    ) mat;
  IF v_mat <> 0 THEN
    RAISE EXCEPTION 'Doi sang system_key lam % cap (org,user) MAT quyen chu. DUNG.', v_mat;
  END IF;

  RAISE NOTICE 'OK: 4 ham neo theo system_key, khong ai mat quyen chu.';
END
$nghiem_thu$;

-- =============================================================================
-- ROLLBACK: CREATE OR REPLACE lại bốn hàm với mệnh đề r.name = 'Chủ sở hữu tổ
-- chức' (bản pg_get_functiondef 15/09/2026 nằm nguyên trong file này, chỉ đổi
-- lại đúng mệnh đề đó). Không đụng dữ liệu nên không cần dump.
--
-- VIỆC CÒN LẠI SAU KHI APPLY (không làm ở đây, cần một lần đo riêng):
--   app_private.guard_system_role_identity() đang chặn cả việc ĐỔI TÊN vai
--   is_system, và COMMENT của nó ghi rõ lý do là "5 hàm còn so theo chuỗi".
--   Lý do đó nay đã hết. Mở lại vế tên là một thay đổi về hành vi giao diện
--   (người dùng được đổi tên vai hệ thống) — để chủ quyết, đừng kèm vào đây.
-- =============================================================================
