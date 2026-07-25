-- =============================================================================
-- Quyết định của chủ sở hữu (2026-07-25) — siết 2 quyền về chỉ mình chủ sở hữu
--
-- NGUYÊN VĂN CHỈ ĐẠO
--   "chi thì auto duyệt khi dưới ngưỡng, trên ngưỡng phải được cấp quyền đó,
--    hiện tại chỉ có tôi có quyền (sau này cần cho ai tôi sẽ click cấp quyền sau)"
--   "quyền xem trang lợi nhuận hiện tại khóa hết tôi sẽ cấp sau, chỉ tôi có quyền"
--
-- (1) income_expenses.approve  -> gỡ khỏi vai trò "Quản Lý Tòa" (cả 2 tổ chức).
--     Giữ trên "Chủ sở hữu tổ chức".
--
--     Vì sao KHÔNG gây kẹt phiếu: vai trò chủ sở hữu có
--     `income_expenses.self_approve_within_limit` (chỉ vai trò này có), nên phiếu
--     do chính chủ lập vẫn tự duyệt được trong hạn mức. Nhóm hạng mục đặc biệt
--     (cọc/hoa hồng/thưởng) không tự duyệt được theo thiết kế — cửa thoát là
--     `emergency_approve_request_v1`, vốn chỉ dành cho membership OWNER, bắt buộc
--     lý do >= 20 ký tự và ghi security event.
--
--     Ngưỡng tự duyệt đang đặt: org thật 300.000đ · org demo 5.000.000đ.
--     Dưới ngưỡng phiếu chi tự duyệt; từ ngưỡng trở lên vào Nháp chờ duyệt.
--
-- (2) shareholder_profit.view -> thu hồi mọi ngoại lệ trừ của chủ sở hữu.
--     Vai trò đã chỉ cấp cho "Chủ sở hữu tổ chức" nên không cần đụng role.
--
--     ⚠ HỆ QUẢ CẦN BIẾT: joey, nathan và bosshuy ĐỀU đang là cổ đông đăng ký
--     (có dòng trong public.shareholders kèm auth_user_id). Ngoại lệ hiện tại của
--     họ sinh ra từ nhánh cổ đông của get_my_permissions. Thu hồi ⇒ họ không xem
--     được phần lợi nhuận của chính mình nữa. Chủ sở hữu đã biết và sẽ cấp lại
--     bằng tay khi cần.
--
-- Thu hồi bằng `revoked_at` (không xoá dòng) để giữ dấu vết audit.
-- Idempotent: chỉ tác động dòng chưa thu hồi.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- (1) Gỡ quyền duyệt phiếu thu chi khỏi vai trò quản lý toà
-- -----------------------------------------------------------------------------
delete from public.role_permissions rp
 using public.organization_roles r
 where r.id = rp.role_id
   and rp.permission_key = 'income_expenses.approve'
   and r.name = 'Quản Lý Tòa';

-- -----------------------------------------------------------------------------
-- (2) Thu hồi ngoại lệ xem trang lợi nhuận của mọi người trừ chủ sở hữu tổ chức
-- -----------------------------------------------------------------------------
update public.member_permission_overrides ov
   set revoked_at = now()
  from public.organization_memberships m
 where m.id = ov.membership_id
   and ov.permission_key = 'shareholder_profit.view'
   and ov.revoked_at is null
   and m.member_type <> 'OWNER';

commit;
