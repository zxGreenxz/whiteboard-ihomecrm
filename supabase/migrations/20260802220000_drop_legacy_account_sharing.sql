-- XOÁ HỆ CHIA SẺ SỔ CŨ
--
-- Đường đọc (RLS accounts, xem phiếu, tồn quỹ) và đường ghi (writer tạo phiếu)
-- đều đã chạy bằng possession. Bản này gỡ nốt mảnh cuối:
--   1. verify_income_expense_v1 — reader duy nhất còn gọi is_account_shared_with_me.
--   2. Xoá dữ liệu bảng cũ (31 dòng) — đúng cửa mà cổng cutover
--      20260723120000 đòi từ 23/07 ("account_shared_users_drain" chỉ PASS khi
--      count = 0) nhưng chưa ai chạy.
--   3. Drop set_cashbook_shared_users_v1: writer ghi vào bảng cũ. Từ nay giao
--      quyền sổ chỉ còn MỘT đường là set_cashbook_access_v2. FE gọi nó đã bị gỡ
--      trong cùng commit (hook useAccountSharedUsers xoá hẳn).
--   4. Drop is_account_shared_with_me.
--
-- GIỮ LẠI bảng rỗng `account_shared_users`: app_private.finance_v2_cutover_readiness_v1
-- và finance_v2_replay_change_log_v1 vẫn đọc nó để đếm/replay; xoá bảng là làm
-- hai hàm đó vỡ. Bảng rỗng + không còn writer = vô hại.
--
-- An toàn khi xoá dữ liệu: đã đo trước bằng giả lập RLS 15 thành viên × 3 org —
-- possession bao trùm toàn bộ quyền nhìn, và writer v1 đã đọc possession nên
-- 23 ô ghi của joey/nathan không mất.
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT khi áp qua Management API. Kiểm lại catalog sau đó.

CREATE OR REPLACE FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.income_expenses%rowtype;
  v_can_see boolean;
  v_full_name text;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Phải đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_id
   for update;
  if not found then
    raise exception 'Không tìm thấy phiếu';
  end if;

  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- Parity verify legacy: caller phải có quyền xem phiếu.
  select (
    public.is_super_admin()
    or public.is_admin()
    or (v_row.building_id is not null and public.can_access_building(v_row.building_id))
    or (v_row.account_id is not null
        and v_row.account_id in (select app_private.my_possessed_cashbook_ids_v1()))
  ) into v_can_see;
  if not v_can_see then
    raise exception 'Không có quyền xem phiếu này' using errcode = '42501';
  end if;

  if v_row.verified_at is not null then
    -- toggle bỏ kiểm: chỉ chủ kiểm hoặc super admin (parity legacy).
    if v_row.verified_by = v_actor or public.is_super_admin() then
      insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      values (v_row.id, pg_current_xact_id(), 'UNVERIFY');

      update public.income_expenses
         set verified_at = null, verified_by = null,
             verified_by_name = null, verified_note = null
       where id = v_row.id;
      get diagnostics v_rows = row_count;

      delete from app_private.ie_transition_authorization
       where income_expense_id = v_row.id and xid = pg_current_xact_id();

      if v_rows <> 1 then
        raise exception 'unverify affected % rows (expected 1)', v_rows using errcode = '55000';
      end if;

      perform app_private.append_income_expense_event_v1(
        v_row.organization_id, v_row.id, 'UNVERIFIED', v_actor,
        app_private.ie_actor_display_name_v1(v_actor),
        v_row.approval_status, v_row.approval_status, null);
      return;
    else
      raise exception 'Phiếu đã được % kiểm — chỉ super admin hoặc người kiểm mới bỏ được',
        coalesce(v_row.verified_by_name, 'người khác');
    end if;
  end if;

  select coalesce(full_name, email, 'Người dùng') into v_full_name
    from public.profiles where id = v_actor;

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'VERIFY');

  update public.income_expenses
     set verified_at = now(), verified_by = v_actor,
         verified_by_name = v_full_name,
         verified_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'verify affected % rows (expected 1)', v_rows using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'VERIFIED', v_actor,
    coalesce(v_full_name, 'Người dùng'),
    v_row.approval_status, v_row.approval_status,
    nullif(btrim(coalesce(p_note, '')), ''));
end;
$function$
;

-- ── 2. Xoá dữ liệu bảng cũ ───────────────────────────────────────────────────
DELETE FROM public.account_shared_users;

-- ── 3+4. Bỏ writer và hàm kiểm của hệ cũ ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.set_cashbook_shared_users_v1(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.is_account_shared_with_me(uuid);
