-- t5_17_approval_engine_config.sql — Cấu hình người duyệt (D1a, owner chốt 2026-07-19)
--
-- QUYẾT ĐỊNH OWNER: người duyệt phiếu chi lương/chia cổ đông = vai trò
-- "Chủ sở hữu tổ chức" của công ty đó, 1 chữ ký (min_approvals=1 đã có sẵn).
-- GIỮ NGUYÊN spec PERMISSION income_expenses.approve có sẵn (union) để phiếu do
-- CHÍNH chủ lập vẫn có người duyệt thứ hai (máy chống tự-duyệt loại maker khỏi
-- danh sách ứng viên — app_private.materialize_step_candidates_v1 M10).
--
-- ĐÃ APPLY inline 2026-07-19 + E2E VERIFIED trên demo:
--   chunha (owner, maker) distribute 1.000.000 → PENDING_APPROVAL
--   → candidates = quanly (chunha bị loại đúng luật) → quanly APPROVE
--   → request POSTED + voucher APPROVED. Chuỗi engine-tiền chạy trọn vòng.
--
-- GATE-0 real-org (PHÁT HIỆN quan trọng, chưa xử lý — chờ activation window):
--   • Org THẬT: KHÔNG member nào resolve income_expenses.approve qua v3
--     (joey/nathan duyệt qua đường legacy) → khi CHỦ là maker, PERMISSION-spec
--     = 0 ứng viên → phiếu của chủ kẹt. Trước khi bật payout org thật phải:
--     grant v3 income_expenses.approve cho role Quản Lý Tòa (khớp thẩm quyền
--     legacy hiện có) HOẶC bind người thứ hai vào role Chủ sở hữu.
--   • Demo đã bind quanly vào role Chủ sở hữu (fixture người-duyệt-thứ-hai).

begin;

-- Approver ROLE "Chủ sở hữu tổ chức" cho mọi step của các rule cần duyệt
-- (Bắt buộc duyệt + Fallback) ở mọi org có rule-set ACTIVE. Idempotent.
insert into public.approval_step_approvers (organization_id, step_id, approver_type, role_id)
select r.organization_id, s.id, 'ROLE', orole.id
  from public.approval_rules r
  join public.approval_rule_sets rs on rs.id = r.rule_set_id and rs.status = 'ACTIVE'
  join public.approval_rule_steps s on s.rule_id = r.id
  join public.organization_roles orole
    on orole.organization_id = r.organization_id
   and orole.name = 'Chủ sở hữu tổ chức'
 where not exists (
   select 1 from public.approval_step_approvers a
    where a.step_id = s.id and a.approver_type = 'ROLE' and a.role_id = orole.id);

commit;

-- Demo fixture (đã chạy riêng, ghi lại để tái lập môi trường test):
--   insert into public.role_bindings (organization_id, membership_id, role_id)
--   select m.organization_id, m.id, r.id
--     from organization_memberships m
--     join auth.users u on u.id=m.user_id and u.email='demo.quanly@username.ihomecrm.local'
--     join organization_roles r on r.organization_id=m.organization_id and r.name='Chủ sở hữu tổ chức'
--    where m.organization_id='dddd0000-0000-4000-8000-000000000001' and m.status='ACTIVE';
