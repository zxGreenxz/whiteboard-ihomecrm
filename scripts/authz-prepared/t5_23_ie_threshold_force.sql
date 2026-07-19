-- t5_23 — PHƯƠNG ÁN DUYỆT ĐẦY ĐỦ (phần cấu hình):
--   owner chốt (2026-07-19): "tất cả phiếu thu chi tự động duyệt, TRỪ (a) hạng
--   mục đặc biệt đã liệt kê — gồm CẢ hạng mục liên quan hợp đồng: hoàn cọc,
--   thanh lý hoàn cọc, ... — và (b) phiếu CHI từ NGƯỠNG cài đặt trở lên.
--   Ngưỡng cài được trong trang Cài đặt; vượt ngưỡng/đặc biệt → phiếu NHÁP
--   chờ duyệt tay. Nhập Excel (batch) giữ tự duyệt (nhập lịch sử)."
-- File này: (1) cờ force_approval trên hạng mục + backfill danh sách,
-- (2) bảng ngưỡng org-wide + RPC get/set (owner-only), (3) hạng mục thanh lý
-- sinh động tự gắn cờ. Writer + engine đọc các nguồn này ở t5_24.

begin;

-- ========== 1) CỜ HẠNG MỤC BẮT BUỘC DUYỆT ==========
alter table public.income_expense_types
  add column if not exists force_approval boolean not null default false;

comment on column public.income_expense_types.force_approval is
  'Hạng mục đặc biệt: phiếu chứa hạng mục này KHÔNG được tự duyệt khi tạo (sinh ở NHÁP chờ duyệt). Backfill t5_23 theo phương án owner.';

-- Backfill: mọi org — nhóm cọc (is_deposit) + hạng mục hợp đồng/thanh lý/hoàn +
-- hoa hồng/thưởng (kể cả tên tắt HHMG lách guard tên) + lương/lợi nhuận.
-- So khớp CHÍNH XÁC cả chuỗi qua nrm_vn (bỏ dấu + lower + đ→d), không substring.
update public.income_expense_types
   set force_approval = true
 where force_approval = false
   and ( coalesce(is_deposit, false)
      or public.nrm_vn(name) in (
        -- hợp đồng / thanh lý / hoàn
        'hoan coc thanh ly',
        'hoan coc / tien thua khi thanh ly',
        'hoan tra thanh ly',
        'hoan tien thua thanh ly',
        'hoan lai tien thua khach dong du',
        'doanh thu bo coc',
        'doanh thu thanh ly',
        'can tru thanh ly',
        'thu thanh ly (khach tra them)',
        'thu thanh ly (khau tru coc)',
        'tien coc khach bo',
        'can coc chuyen doanh thu',
        'can cong no vao coc',
        'tien thoi',
        -- hoa hồng / thưởng
        'hoa hong moi gioi',
        'thuong nong sale',
        'hhmg',
        -- lương / lợi nhuận
        'tien luong',
        'luong dieu hanh',
        'luong quan ly',
        'ung luong quan ly',
        'chia loi nhuan co dong',
        'quan ly'
      ));

-- ========== 2) NGƯỠNG TỰ DUYỆT PHIẾU CHI (org-wide, cài trong Cài đặt) ==========
create table if not exists app_private.ie_auto_approve_config (
  organization_id uuid primary key,
  threshold numeric(15,2) check (threshold is null or threshold > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

comment on table app_private.ie_auto_approve_config is
  'Ngưỡng tự duyệt phiếu CHI thường (t5_23). NULL/không dòng = tự duyệt mọi phiếu chi thường (hành vi hiện tại); đặt số = chi >= ngưỡng sinh ở NHÁP.';

-- Đọc ngưỡng: mọi thành viên org (UI hiển thị). Org suy từ membership; user
-- nhiều org → ưu tiên org mà user giữ role "Chủ sở hữu tổ chức".
create or replace function public.get_ie_auto_approve_threshold_v1()
returns numeric
language plpgsql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
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
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;
  return (select c.threshold from app_private.ie_auto_approve_config c
           where c.organization_id = v_org);
end;
$fn$;

-- Đặt ngưỡng: CHỈ chủ sở hữu tổ chức (role "Chủ sở hữu tổ chức") hoặc super admin.
-- p_threshold NULL = bỏ ngưỡng (tự duyệt mọi phiếu chi thường như hiện tại).
create or replace function public.set_ie_auto_approve_threshold_v1(p_threshold numeric)
returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
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
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;

  select exists (
    select 1 from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = 'ACTIVE'
      join public.organization_roles r
        on r.id = rb.role_id and r.name = 'Chủ sở hữu tổ chức'
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
$fn$;

grant execute on function public.get_ie_auto_approve_threshold_v1() to authenticated;
grant execute on function public.set_ie_auto_approve_threshold_v1(numeric) to authenticated;

-- ========== 3) HẠNG MỤC THANH LÝ SINH ĐỘNG TỰ GẮN CỜ ==========
create or replace function public._termination_ensure_type(p_user_id uuid, p_type text, p_name text)
returns uuid
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
begin
  select id into v_id
    from income_expense_types
   where user_id = p_user_id
     and lower(name) = lower(p_name)
     and lower(type) = lower(p_type)
   limit 1;

  if v_id is not null then
    -- t5_23: hạng mục thanh lý luôn thuộc nhóm bắt buộc duyệt
    update income_expense_types set force_approval = true
     where id = v_id and force_approval = false;
    return v_id;
  end if;

  insert into income_expense_types (user_id, type, name, description, force_approval)
  values (p_user_id, lower(p_type), p_name,
          'Tự tạo khi thanh lý hợp đồng', true)
  returning id into v_id;

  return v_id;
end;
$fn$;

commit;
