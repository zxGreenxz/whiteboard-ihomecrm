-- =============================================================================
-- T4a — Hàm ghi nhật ký phân quyền có CHUỖI HASH (nền cho 6 RPC quản trị)
--
-- KHẢO SÁT TRƯỚC KHI VIẾT
--   public.authorization_audit_events đã tồn tại với cột prev_hash / event_hash,
--   nhưng: 0 dòng · KHÔNG trigger nào · KHÔNG hàm nào ghi vào nó.
--   Tức cột chuỗi hash được thiết kế sẵn nhưng CHƯA CÓ cách nối. Không có gì để
--   tái sử dụng — phải dựng, và dựng một lần cho cả 6 RPC dùng chung để không
--   mỗi nơi một kiểu.
--
-- CHUỖI HASH DÙNG ĐỂ LÀM GÌ
--   Mỗi dòng nhật ký mang hash của chính nó, tính từ hash dòng TRƯỚC trong cùng
--   tổ chức. Sửa/xoá một dòng giữa chuỗi sẽ làm mọi dòng sau đó lệch hash ⇒ phát
--   hiện được. Đây là "tamper-evident", KHÔNG phải "tamper-proof": người có quyền
--   database vẫn tính lại được cả chuỗi. Muốn chống cả điều đó thì phải đẩy hash
--   ra kho ngoài — AUTHORIZATION-PLAN §0 cảnh báo đúng chỗ này.
--
-- ĐỒNG THỜI
--   Hai lời gọi song song cùng tổ chức có thể đọc trúng cùng một prev_hash rồi
--   ghi hai dòng cùng trỏ về một cha ⇒ chuỗi rẽ nhánh, mất tính kiểm chứng.
--   Dùng pg_advisory_xact_lock theo organization_id để tuần tự hoá trong phạm vi
--   transaction. Khoá tự nhả khi commit/rollback, không cần dọn.
--   Chi phí chấp nhận được: thay đổi phân quyền là thao tác hiếm.
--
-- Không ai gọi hàm này sau migration ⇒ không đổi hành vi production.
-- =============================================================================

begin;

create or replace function app_private.append_authz_audit_v1(
  p_organization_id uuid,
  p_event_type      text,
  p_resource_type   text,
  p_resource_id     uuid,
  p_old_state       jsonb default null,
  p_new_state       jsonb default null,
  p_reason          text  default null
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private', 'extensions'
as $fn$
declare
  v_id        uuid := gen_random_uuid();
  v_actor     uuid := (select auth.uid());
  v_membership uuid;
  v_prev      text;
  v_at        timestamptz := clock_timestamp();
  v_payload   text;
  v_hash      text;
begin
  if p_organization_id is null then
    raise exception 'Thiếu tổ chức khi ghi nhật ký phân quyền' using errcode = '22023';
  end if;
  if p_event_type is null or btrim(p_event_type) = '' then
    raise exception 'Thiếu loại sự kiện khi ghi nhật ký phân quyền' using errcode = '22023';
  end if;

  -- Tuần tự hoá theo tổ chức để chuỗi hash không rẽ nhánh.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  select m.id into v_membership
    from public.organization_memberships m
   where m.user_id = v_actor
     and m.organization_id = p_organization_id
     and m.status = 'ACTIVE'
   limit 1;

  -- Mắt xích trước trong CÙNG tổ chức. Dòng đầu tiên có prev_hash = NULL.
  select a.event_hash into v_prev
    from public.authorization_audit_events a
   where a.organization_id = p_organization_id
   order by a.occurred_at desc, a.id desc
   limit 1;

  -- Nội dung băm: gắn chặt vào mọi trường có ý nghĩa audit, kèm mắt xích trước.
  v_payload :=
       coalesce(v_prev, '')
    || '|' || p_organization_id::text
    || '|' || v_at::text
    || '|' || coalesce(v_actor::text, '')
    || '|' || coalesce(v_membership::text, '')
    || '|' || p_event_type
    || '|' || coalesce(p_resource_type, '')
    || '|' || coalesce(p_resource_id::text, '')
    || '|' || coalesce(p_old_state::text, '')
    || '|' || coalesce(p_new_state::text, '')
    || '|' || coalesce(p_reason, '');

  v_hash := encode(extensions.digest(v_payload, 'sha256'), 'hex');

  insert into public.authorization_audit_events (
    id, organization_id, occurred_at, actor_user_id, actor_membership_id,
    event_type, resource_type, resource_id, old_state, new_state, reason,
    prev_hash, event_hash
  ) values (
    v_id, p_organization_id, v_at, v_actor, v_membership,
    p_event_type, p_resource_type, p_resource_id, p_old_state, p_new_state, p_reason,
    v_prev, v_hash
  );

  return v_id;
end
$fn$;

comment on function app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text) is
  'Ghi một dòng nhật ký phân quyền và nối vào chuỗi hash của tổ chức. Dùng chung cho mọi RPC quản trị — đừng INSERT thẳng vào authorization_audit_events.';

-- -----------------------------------------------------------------------------
-- Hàm kiểm tra chuỗi: soi xem có dòng nào bị sửa/xoá không.
-- Trả về các mắt xích gãy; rỗng = chuỗi lành.
-- -----------------------------------------------------------------------------
create or replace function app_private.verify_authz_audit_chain_v1(p_organization_id uuid)
returns table (event_id uuid, occurred_at timestamptz, van_de text)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private', 'extensions'
as $fn$
  with chuoi as (
    select a.*,
           lag(a.event_hash) over (order by a.occurred_at, a.id) as prev_thuc_te
      from public.authorization_audit_events a
     where a.organization_id = p_organization_id
  )
  select c.id, c.occurred_at,
         case
           when c.prev_hash is distinct from c.prev_thuc_te
             then 'Mắt xích trước không khớp — có dòng bị sửa hoặc xoá'
           else 'Hash của chính dòng này không khớp nội dung'
         end
    from chuoi c
   where c.prev_hash is distinct from c.prev_thuc_te
      or c.event_hash is distinct from encode(extensions.digest(
           coalesce(c.prev_thuc_te,'')
        || '|' || c.organization_id::text
        || '|' || c.occurred_at::text
        || '|' || coalesce(c.actor_user_id::text,'')
        || '|' || coalesce(c.actor_membership_id::text,'')
        || '|' || c.event_type
        || '|' || coalesce(c.resource_type,'')
        || '|' || coalesce(c.resource_id::text,'')
        || '|' || coalesce(c.old_state::text,'')
        || '|' || coalesce(c.new_state::text,'')
        || '|' || coalesce(c.reason,''), 'sha256'), 'hex')
   order by c.occurred_at;
$fn$;

comment on function app_private.verify_authz_audit_chain_v1(uuid) is
  'Soi chuỗi hash nhật ký phân quyền của một tổ chức. Trả rỗng = chưa phát hiện can thiệp.';

-- Nội bộ: chỉ RPC quản trị (SECURITY DEFINER) gọi. Không cấp cho client role nào.
revoke all on function app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text)
  from public, anon, authenticated;
revoke all on function app_private.verify_authz_audit_chain_v1(uuid)
  from public, anon, authenticated;

commit;
