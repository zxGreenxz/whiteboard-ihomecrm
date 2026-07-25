-- =============================================================================
-- NGÀY G (phần cuối) — NGẮT CẦU NỐI VỚI HỆ CŨ
--
-- Chỉ đạo chủ sở hữu 25/07: "làm triệt để đi, toàn bộ nhân viên của tôi sẽ không
-- dùng trong 1 tuần, cứ làm triệt để."
--
-- === ĐANG NGẮT CÁI GÌ ===
-- Hai trigger trên public.staff_assignments đồng bộ bảng cũ -> role_bindings:
--   a80_sa_revoke_sync  -> sync_revoke_role_binding_v1()   (xoá phân công = thu hồi)
--   a81_sa_role_change_sync -> sync_regrant_role_binding_v1() (sửa = thu hồi + cấp lại)
--
-- Sau phần 1–3, mô hình tổ chức đã là nguồn quyết định duy nhất:
--   · 74 policy gọi thẳng buildings_for_v3
--   · 11 helper (192 policy + 71 hàm) đọc mô hình mới
--   · get_my_permissions / ai_copilot_perms_for đọc mô hình mới
-- Giữ trigger lại sẽ khiến việc sửa bảng cũ ÂM THẦM ghi đè phân quyền mới —
-- đúng loại sự cố đã xảy ra ngày 20/07 (trigger revoke-only khoá 2 nhân viên 2 ngày).
--
-- === HỆ QUẢ, ĐÃ ĐƯỢC CHẤP THUẬN ===
-- Màn "Phân quyền nhân viên" cũ NGỪNG có tác dụng kể từ đây: nó vẫn ghi được vào
-- staff_assignments nhưng không còn ảnh hưởng quyền thật. Đây là lý do phải có
-- màn quản trị mới (T5) trước khi nhân viên dùng lại.
--
-- === VÌ SAO DISABLE CHỨ KHÔNG DROP ===
-- DISABLE giữ nguyên định nghĩa trigger trong catalog: quay lui chỉ là một lệnh
-- ENABLE, không cần dựng lại hàm. Bảng cũ cũng giữ nguyên, chưa xoá gì —
-- việc dọn (đổi tên bảng, xoá sau 30 ngày) thuộc bước T7.
-- =============================================================================

begin;

alter table public.staff_assignments disable trigger a80_sa_revoke_sync;
alter table public.staff_assignments disable trigger a81_sa_role_change_sync;

comment on table public.staff_assignments is
  'HỆ CŨ — không còn là nguồn quyết định phân quyền kể từ cutover 2026-07-25. Hai trigger đồng bộ a80/a81 đã tắt. Giữ lại để đối chiếu; dọn ở bước T7. Nguồn thật: organization_memberships + role_bindings + member_permission_overrides.';

-- Chốt chặn: xác nhận đã tắt đúng hai trigger.
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'staff_assignments'
     and tg.tgname in ('a80_sa_revoke_sync', 'a81_sa_role_change_sync')
     and tg.tgenabled <> 'D';
  if v_n <> 0 then
    raise exception 'Còn % trigger đồng bộ hệ cũ chưa tắt', v_n;
  end if;
end $$;

-- Danh sách "chủ cũ" đã hết vai trò: get_my_permissions không còn đọc nó.
-- Xoá nốt để không còn đường nào cấp toàn quyền ngoài vai trò và bảng platform.
delete from public.legacy_owner_allowlist;

commit;
