-- P0 BẢO MẬT: siết RLS bảng public.notifications về own-row.
--
-- VÌ SAO: đo bằng impersonation (begin…rollback, SELECT KHÔNG lọc user_id) ngày 29/07/2026:
--   bosshuy   (PARTNER, không có mảnh quyền notifications nào) thấy 1006 dòng — 984 của người khác
--   demo.sale (STAFF org DEMO)                                 thấy  375 dòng — 235 THUỘC ORG THẬT
--   nathan    (STAFF org thật)                                 thấy 1006 dòng — 348 của người khác
--   demo.chunha (OWNER org DEMO, KHÔNG phải super admin)        XOÁ ĐƯỢC 251 dòng của chủ org thật
--
-- Thủ phạm là hai policy chỉ hỏi "người nhận có phải đồng nghiệp trong MỘT org nào đó của tôi",
-- không hỏi dòng thuộc org nào:
--   notifications_select_staff  USING (user_id = ANY (current_visible_owner_ids()))
--   notifications_staff_delete  staff_can('notifications','delete', user_id)
-- current_visible_owner_ids() = mọi thành viên ACTIVE của MỌI org mình thuộc. Vì tài khoản chủ vừa
-- là OWNER org thật vừa là STAFF org DEMO nên nó bắc cầu dữ liệu hai tổ chức.
--
-- AN TOÀN ĐỂ SIẾT: bảng chỉ có 3 màn hình tiêu thụ (NotificationBell, NotificationsPage,
-- NotificationsMobilePage) và cả ba đều là hộp thư của chính mình; 11/11 hàm DB đụng bảng này đều
-- SECURITY DEFINER owner=postgres (rolbypassrls=true) nên ĐƯỜNG SINH thông báo không đi qua RLS.
-- Đã chứng minh bằng probe song sinh DEFINER/INVOKER.
--
-- KẾT QUẢ ĐO SAU VÁ (cùng transaction rollback): bosshuy 22/0 · demo.sale 20/0 (org thật 0) ·
-- nathan 658/0 · chủ 251/0 và VẪN THẤY 16 dòng organization_id IS NULL · demo.chunha xoá được 0,
-- "xoá tất cả đã đọc" khớp 0 dòng người khác, "đánh dấu tất cả đã đọc" khớp 0 dòng người khác.

begin;

-- 1) Gỡ 2 policy rò rỉ + 2 policy CHẾT.
--    staff_update/staff_insert là policy ngủ đông: KHÔNG role nào có notifications.edit/.create
--    (role_permissions chỉ cấp .view và .delete).
drop policy if exists "notifications_select_staff" on public.notifications;
drop policy if exists "notifications_staff_delete" on public.notifications;
drop policy if exists "notifications_staff_insert" on public.notifications;
drop policy if exists "notifications_staff_update" on public.notifications;

-- 2) Gộp 5 policy own-row trùng lặp (roles={public}) thành 4 policy tường minh, TO authenticated.
drop policy if exists "Users can manage own notifications" on public.notifications;
drop policy if exists "Users can view own notifications"   on public.notifications;
drop policy if exists "Users can insert own notifications" on public.notifications;
drop policy if exists "Users can update own notifications" on public.notifications;
drop policy if exists "Users can delete own notifications" on public.notifications;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists notifications_insert_own on public.notifications;
create policy notifications_insert_own on public.notifications
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- 3) BỎ bypass super-admin.
--    Giữ nó nghĩa là hộp thư của chủ vẫn hiện 1130 dòng ở tầng DB và chỉ đúng nhờ FE lọc; đồng thời
--    4 truy vấn dedupe trong src/lib/notificationScheduler.ts vẫn nhìn thấy dòng của người khác.
--    Không đường code nào cần bypass: 11 hàm sinh thông báo đều chạy dưới postgres.
--    HOÀN TÁC nếu cần:
--      create policy notifications_super_admin_all on public.notifications
--        for all to authenticated
--        using ((select public.is_super_admin())) with check ((select public.is_super_admin()));
drop policy if exists notifications_super_admin_all on public.notifications;

-- 4) RESTRICTIVE org boundary — khuôn y hệt 29 bảng đang có (29/29 đều có escape IS NULL, nhờ đó
--    16 dòng organization_id NULL của chủ không bị mất).
--    TRUNG THỰC: hôm nay policy này đóng góp ĐÚNG 0 dòng vì own-row đã đủ. Đây là phòng vệ chiều
--    sâu, để lần sau ai thêm một policy permissive rộng thì ranh giới tenant vẫn kín.
drop policy if exists notifications_org_boundary on public.notifications;
create policy notifications_org_boundary on public.notifications
  as restrictive for all to authenticated
  using (organization_id is null
         or (select public.is_super_admin())
         or organization_id in (select unnest(public.my_org_ids())))
  with check (organization_id is null
              or (select public.is_super_admin())
              or organization_id in (select unnest(public.my_org_ids())));

-- 5) Dọn quyền thừa. RLS KHÔNG áp cho TRUNCATE nên hai câu này thực sự gỡ quyền:
--    đo 29/07 (information_schema.role_table_grants) — anon đang có DELETE/INSERT/REFERENCES/
--    SELECT/TRIGGER/TRUNCATE/UPDATE, authenticated cũng có TRUNCATE.
revoke all on public.notifications from anon;
revoke truncate on public.notifications from authenticated;

notify pgrst, 'reload schema';

commit;
