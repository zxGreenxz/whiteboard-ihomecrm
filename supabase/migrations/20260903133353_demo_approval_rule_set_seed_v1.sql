-- G3-FIX migration 2/2 — DML: seed một approval_rule_set ACTIVE tối thiểu cho
-- MỘT MÌNH org DEMO (dddd0000-0000-4000-8000-000000000001).
--
-- VÌ SAO CẦN — task-G3-E2E-report.md §1.2 đo thật trên production 03/09/2026:
--   approval_rule_sets WHERE organization_id = DEMO  → 0 hàng
--   approval_rule_sets (toàn hệ thống)                → 1 hàng, thuộc org khác
-- `submit_financial_voucher` (20260713130200) fail-CLOSED khi không có rule
-- ACTIVE: `_eval_approval_rule` trả NULL, RAISE 'Không có rule set ACTIVE'.
-- Sprint 4b (20260713130100) từng seed một bộ cho MỌI org tồn tại LÚC ĐÓ —
-- DEMO ra đời sau, nên bỏ lỡ.
--
-- BẪY ĐO ĐƯỢC TRONG CHÍNH PHIÊN NÀY — vì sao KHÔNG insert thẳng status=ACTIVE.
--   Bản đầu của migration này chép y khuôn 20260713130100 (INSERT rule_set với
--   status='ACTIVE' ngay, rồi INSERT rules/steps/approvers tham chiếu nó).
--   `node scripts/check-forward-migration-idempotent.mjs` (dry-run ROLLBACK
--   trên production) bắt lỗi ngay: production giờ có
--   `app_private.guard_published_rule_set()` (trigger `a00_rules_immutable`
--   trên approval_rules — "H6 fix", KHÔNG có trong bất kỳ migration nào của
--   repo, tức được vá ngoài lane) chặn MỌI INSERT/UPDATE/DELETE vào
--   approval_rules một khi approval_rule_sets.status đã ACTIVE/RETIRED —
--   "rules of a published rule set are immutable" (55000). Khuôn cũ chỉ chạy
--   được hồi 13/07 vì trigger đó CHƯA TỒN TẠI lúc đó; chạy lại hôm nay sẽ vỡ
--   ngay ở lượt ĐẦU TIÊN, không riêng gì lượt lặp lại.
--
--   Sửa đúng bằng cách đi qua giao thức mà chính guard đó cho phép:
--     1. Tạo rule_set ở trạng thái DRAFT (guard chỉ khoá ACTIVE/RETIRED).
--     2. Chèn rule/step/approver — hợp lệ vì rule_set còn DRAFT.
--     3. Gọi `app_private.publish_rule_set_v1(rule_set_id, actor)` — đúng RPC
--        nội bộ mà comment của guard đặt tên là đường HỢP LỆ DUY NHẤT để
--        DRAFT→ACTIVE. Hàm này tự kiểm "đúng 1 rule fallback REQUIRE_APPROVAL"
--        (M7 fix, cũng ngoài lane) trước khi flip, và tự RETIRE bản ACTIVE cũ
--        cùng (organization_id, transaction_domain) nếu có — ở đây không có
--        (đã đo 0 hàng DEMO trước khi viết migration), nên UPDATE đó ảnh hưởng
--        0 hàng.
--
--   Mọi INSERT dùng `SELECT ... WHERE NOT EXISTS` thay vì `VALUES ... ON
--   CONFLICT DO NOTHING`: BEFORE INSERT ROW trigger chạy TRƯỚC khi Postgres
--   xét ON CONFLICT, nên `ON CONFLICT DO NOTHING` KHÔNG cứu được lượt chạy lại
--   sau khi rule_set đã ACTIVE — trigger vẫn nổ trên hàng ứng viên dù nó sẽ bị
--   bỏ qua. `WHERE NOT EXISTS` làm SELECT nguồn trả 0 hàng khi đã tồn tại, nên
--   INSERT không có hàng nào để thử và trigger không bị gọi. Đã đo lại bằng
--   `check-forward-migration-idempotent.mjs` (chạy 2 lần trong 1 transaction,
--   ROLLBACK) sau khi sửa — xanh.
--
-- HÌNH DẠNG rule — chép nhánh fallback của 20260713130100 (không chép hai rule
-- 100/200 — DEMO không cần auto-post nội bộ hay đánh dấu SENSITIVE):
--   priority 1000, is_fallback=true, effect=REQUIRE_APPROVAL, KHÔNG auto-post,
--   KHÔNG deny. `_eval_approval_rule` khớp is_fallback VÔ ĐIỀU KIỆN (matches
--   CTE: `r.is_fallback OR (...)`), nên MỌI phiếu income_expenses của DEMO —
--   không lọc theo transaction_type/category/cashbook/building/amount — đều
--   rơi vào REQUIRE_APPROVAL. Một step (ANY, min_approvals=1), approver
--   PERMISSION income_expenses.approve — đúng cấu trúc mà mọi rule set khác
--   trong hệ thống mang (runtime của `submit_financial_voucher` tự liệt kê lại
--   OWNER/super_admin/permission-holder làm ứng viên, không đọc bảng approver
--   lúc chấm — nhưng bảng đó vẫn phải có hàng để rule set đúng hình dạng, và
--   `publish_rule_set_v1` không kiểm nó nên không bắt buộc về mặt kỹ thuật,
--   chỉ về mặt nhất quán dữ liệu). "Checker = vai chủ (chunha)" của brief tự
--   động đúng: DEMO có đúng 1 thành viên member_type='OWNER' ACTIVE (đo trước
--   khi viết migration này), và `submit_financial_voucher` LUÔN đưa OWNER vào
--   danh sách ứng viên bất kể approver_type khai trong bảng structural này.
--
-- IDEMPOTENT — xem giải thích WHERE NOT EXISTS ở trên; đã đo bằng dry-run 2
-- lượt. DB RỖNG (Restore Drill chưa seed tổ chức nào): org DEMO không tồn tại
-- → RAISE NOTICE rồi RETURN, không lỗi, không tạo rule set mồ côi. KHÔNG đụng
-- tới bất kỳ org nào khác — mọi câu lệnh (kể cả UPDATE...RETIRED bên trong
-- publish_rule_set_v1) đều khoá theo v_rs.organization_id = ORG (hằng số),
-- không phải vòng lặp theo bảng organizations như bản 20260713130100.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $tien_de$
BEGIN
  IF to_regprocedure('app_private.publish_rule_set_v1(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'app_private.publish_rule_set_v1(uuid, uuid) missing — cannot publish DRAFT rule set';
  END IF;
END
$tien_de$;

DO $seed$
DECLARE
  ORG constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_org_ton_tai boolean;
  v_rs        uuid;
  v_rs_status text;
  v_rule      uuid;
  v_step      uuid;
  v_actor     uuid;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.organizations WHERE id = ORG) INTO v_org_ton_tai;
  IF NOT v_org_ton_tai THEN
    RAISE NOTICE 'demo_approval_rule_set_seed_v1: to chuc DEMO % khong ton tai (DB rong hoac chua seed) — bo qua, khong loi.', ORG;
    RETURN;
  END IF;

  -- 1. Rule set FINANCIAL_VOUCHER v1, bắt đầu ở DRAFT (guard chỉ khoá
  -- ACTIVE/RETIRED — xem giải thích ở đầu file).
  INSERT INTO public.approval_rule_sets (organization_id, transaction_domain, version, status)
  SELECT ORG, 'FINANCIAL_VOUCHER', 1, 'DRAFT'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.approval_rule_sets
     WHERE organization_id = ORG AND transaction_domain = 'FINANCIAL_VOUCHER' AND version = 1
  );

  SELECT id, status INTO v_rs, v_rs_status FROM public.approval_rule_sets
   WHERE organization_id = ORG AND transaction_domain = 'FINANCIAL_VOUCHER' AND version = 1;

  -- 2. Fallback REQUIRE_APPROVAL — không AUTO_POST, không DENY, không lọc
  -- theo điều kiện nào (is_fallback khớp mọi phiếu). `WHERE NOT EXISTS` chặn
  -- INSERT không thử lại trên rule_set đã publish (xem đầu file).
  INSERT INTO public.approval_rules (organization_id, rule_set_id, name, priority, effect, is_fallback)
  SELECT ORG, v_rs, 'DEMO fallback — moi phieu can duyet (G3-FIX)', 1000, 'REQUIRE_APPROVAL', true
  WHERE NOT EXISTS (SELECT 1 FROM public.approval_rules WHERE rule_set_id = v_rs AND priority = 1000);

  SELECT id INTO v_rule FROM public.approval_rules WHERE rule_set_id = v_rs AND priority = 1000;

  INSERT INTO public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
  SELECT ORG, v_rule, 1, 1, 'ANY'
  WHERE NOT EXISTS (SELECT 1 FROM public.approval_rule_steps WHERE rule_id = v_rule AND step_no = 1);

  SELECT id INTO v_step FROM public.approval_rule_steps WHERE rule_id = v_rule AND step_no = 1;

  INSERT INTO public.approval_step_approvers (organization_id, step_id, approver_type, permission_key)
  SELECT ORG, v_step, 'PERMISSION', 'income_expenses.approve'
  WHERE NOT EXISTS (SELECT 1 FROM public.approval_step_approvers WHERE step_id = v_step);

  -- 3. Publish — CHỈ khi rule_set còn DRAFT (lượt chạy lại thấy ACTIVE thì bỏ
  -- qua, tránh gọi lại publish_rule_set_v1 trên rule set đã publish, thứ tự
  -- hàm đó tự chặn bằng 'only DRAFT rule sets can be published').
  IF v_rs_status = 'DRAFT' THEN
    SELECT m.user_id INTO v_actor
      FROM public.organization_memberships m
     WHERE m.organization_id = ORG AND m.member_type = 'OWNER' AND m.status = 'ACTIVE'
     ORDER BY m.id LIMIT 1;

    PERFORM app_private.publish_rule_set_v1(v_rs, v_actor);
  END IF;

  RAISE NOTICE 'demo_approval_rule_set_seed_v1: rule set % (rule %, step %) san sang cho org DEMO %.',
    v_rs, v_rule, v_step, ORG;
END
$seed$;

-- Nghiệm thu — chỉ khẳng định khi org DEMO có thật (DB rỗng thì khối này cũng
-- phải là no-op, không được biến thành RAISE trên một schema chưa seed).
DO $nghiem_thu$
DECLARE
  ORG constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_status text;
  v_effect text;
  v_is_fallback boolean;
  v_min_approvals int;
  v_mode text;
  v_approver_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = ORG) THEN
    RAISE NOTICE 'demo_approval_rule_set_seed_v1: nghiem thu bo qua — to chuc DEMO khong ton tai.';
    RETURN;
  END IF;

  SELECT status INTO v_status FROM public.approval_rule_sets
   WHERE organization_id = ORG AND transaction_domain = 'FINANCIAL_VOUCHER' AND version = 1;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'demo_approval_rule_set_seed_v1: rule set DEMO khong ACTIVE (status=%)', v_status;
  END IF;

  SELECT r.effect, r.is_fallback INTO v_effect, v_is_fallback
    FROM public.approval_rules r
    JOIN public.approval_rule_sets s ON s.id = r.rule_set_id
   WHERE s.organization_id = ORG AND s.transaction_domain = 'FINANCIAL_VOUCHER' AND s.version = 1
     AND r.priority = 1000;
  IF v_effect IS DISTINCT FROM 'REQUIRE_APPROVAL' OR v_is_fallback IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'demo_approval_rule_set_seed_v1: fallback rule sai hinh dang (effect=%, is_fallback=%)',
      v_effect, v_is_fallback;
  END IF;

  SELECT st.min_approvals, st.mode INTO v_min_approvals, v_mode
    FROM public.approval_rule_steps st
    JOIN public.approval_rules r ON r.id = st.rule_id
    JOIN public.approval_rule_sets s ON s.id = r.rule_set_id
   WHERE s.organization_id = ORG AND r.priority = 1000 AND st.step_no = 1;
  IF v_min_approvals IS DISTINCT FROM 1 OR v_mode IS DISTINCT FROM 'ANY' THEN
    RAISE EXCEPTION 'demo_approval_rule_set_seed_v1: step 1 sai hinh dang (min_approvals=%, mode=%)',
      v_min_approvals, v_mode;
  END IF;

  SELECT count(*) INTO v_approver_count
    FROM public.approval_step_approvers a
    JOIN public.approval_rule_steps st ON st.id = a.step_id
    JOIN public.approval_rules r ON r.id = st.rule_id
    JOIN public.approval_rule_sets s ON s.id = r.rule_set_id
   WHERE s.organization_id = ORG AND r.priority = 1000 AND st.step_no = 1
     AND a.approver_type = 'PERMISSION' AND a.permission_key = 'income_expenses.approve';
  IF v_approver_count < 1 THEN
    RAISE EXCEPTION 'demo_approval_rule_set_seed_v1: khong co approver PERMISSION income_expenses.approve';
  END IF;

  RAISE NOTICE 'demo_approval_rule_set_seed_v1: nghiem thu dat — rule set ACTIVE, fallback REQUIRE_APPROVAL, 1 step ANY, approver PERMISSION income_expenses.approve.';
END
$nghiem_thu$;

COMMIT;
