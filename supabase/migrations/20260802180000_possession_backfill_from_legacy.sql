-- BACKFILL POSSESSION TỪ HỆ CŨ — bước chuẩn bị, KHÔNG đổi hành vi
--
-- Cuộc chuyển sang hệ possession (CUSTODIAN/KNOWER, 19/07/2026) bỏ sót đúng một
-- mắt xích: quyền NHÌN THẤY sổ quỹ. RLS `accounts` vẫn nguyên bản 16/05:
--     accounts_select         → auth.uid() = user_id
--     accounts_select_shared  → is_account_shared_with_me(id) → account_shared_users
-- Không migration nào đổi policy này, và KHÔNG có trigger đồng bộ nào giữa hai
-- bảng theo bất kỳ chiều nào. Vì màn thu tiền dựng danh sách sổ từ `accounts`,
-- tick KNOWER/CUSTODIAN trong dialog "Cập nhật sổ quỹ" KHÔNG tác dụng lên chip
-- TM/TK/TT (ca 111PVC của joey: 158PVC chạy chỉ vì HKDHUY còn dòng legacy từ
-- 26/05, HKDHIEN thì không).
--
-- Migration này CHỈ bù binding còn thiếu để possession trở thành tập CHA của
-- những gì người dùng đang thấy. Chưa đụng RLS — việc đó ở migration sau.
--
-- ⚠ THỨ TỰ BẮT BUỘC: backfill TRƯỚC, đổi RLS SAU. Sổ ảo (thối/làm tròn) gần như
-- không có binding: 13 sổ ảo / 12 binding và tất cả thuộc mình chủ. Riêng
-- "Làm tròn tiền thiếu" hiện chỉ đến được joey/nathan QUA ĐÚNG dòng legacy sắp
-- xoá. Đổi RLS trước là gãy luồng thu có tiền thối/làm tròn của cả hai người thu.
--
-- Đã đo trước khi viết: 0 dòng share nào thuộc user không còn membership ACTIVE,
-- nên không ai bị rơi lại phía sau.

-- ── 1. Người đang được CHIA SẺ sổ (hệ cũ) → KNOWER ───────────────────────────
-- KNOWER = "được xem sổ và số dư, không được Thu/Chi" — đúng nghĩa một dòng
-- share. KHÔNG tự nâng ai lên CUSTODIAN: giữ đúng doctrine "never auto-CUSTODIAN"
-- của backfill 20260723040000.
INSERT INTO public.cashbook_possession_bindings
  (organization_id, cashbook_id, membership_id, possession_kind, reason)
SELECT a.organization_id, a.id, m.id, 'KNOWER',
       'backfill 02/08/2026: account_shared_users → possession (chuẩn bị bỏ RLS legacy)'
FROM public.account_shared_users s
JOIN public.accounts a
  ON a.id = s.account_id AND a.deleted_at IS NULL
JOIN public.organization_memberships m
  ON m.user_id = s.user_id
 AND m.organization_id = a.organization_id
 AND m.status = 'ACTIVE'
WHERE NOT EXISTS (
  SELECT 1 FROM public.cashbook_possession_bindings cp
  WHERE cp.cashbook_id = a.id AND cp.membership_id = m.id AND cp.valid_to IS NULL)
ON CONFLICT DO NOTHING;

-- ── 2. CHỦ sổ chưa có binding → CUSTODIAN ────────────────────────────────────
-- Chủ sổ vốn nhìn thấy sổ qua policy `accounts_select` (giữ nguyên), nên bước
-- này không phải để cứu quyền nhìn — nó để possession NÓI ĐÚNG SỰ THẬT trước
-- khi `ie_visible_cashbook_ids_v1` chuyển sang chỉ đọc possession. Chủ sổ trực
-- tiếp giữ tiền ⇒ CUSTODIAN. Phần lớn rơi vào sổ ảo "…Thối" của chính người thu.
INSERT INTO public.cashbook_possession_bindings
  (organization_id, cashbook_id, membership_id, possession_kind, reason)
SELECT a.organization_id, a.id, m.id, 'CUSTODIAN',
       'backfill 02/08/2026: chủ sổ (accounts.user_id) chưa có binding'
FROM public.accounts a
JOIN public.organization_memberships m
  ON m.user_id = a.user_id
 AND m.organization_id = a.organization_id
 AND m.status = 'ACTIVE'
WHERE a.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.cashbook_possession_bindings cp
    WHERE cp.cashbook_id = a.id AND cp.membership_id = m.id AND cp.valid_to IS NULL)
ON CONFLICT DO NOTHING;
