-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R7b: công tắc shareholder_profit.ledger_payout.v1 ON → SHADOW.
--
-- DÙNG KHI: lùi Đợt 3b (20261115113532) — thôi chi theo sổ tổng, về chế độ chuẩn bị (xem sổ, đặt mốc).
--   Thường chạy sau R7a (đang đóng băng thì route VẪN FROZEN — evaluate_feature_route xét force_freeze trước
--   mode — cho tới R7c).
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_ve_shadow   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- LÀM GÌ
--   0. Khoá công ty (G v2). Còn phiếu chi theo sổ tổng (profit.ledger_payout / profit.manager_salary) CHỜ DUYỆT
--      hoặc ĐÃ DUYỆT CHƯA GHI SỔ ⇒ DỪNG R7B_PHIEU_KET kèm số phiếu: chốt F1 chỉ cho duyệt / ghi sổ khi CANONICAL,
--      về SHADOW là các phiếu đó kẹt. Xử lý hết trước: duyệt + ghi sổ khi còn ON (gỡ đóng băng nếu đang R7a), hoặc
--      huỷ có lý do (E6 — chạy ở MỌI route, kể cả khi đóng băng).
--   1. app_private.set_feature_route_v1(…, 'SHADOW', bốn trường danh tính NULL) — CAS theo config_version đọc
--      lúc chạy; người ghi = tài khoản chủ TENANT_OWNER kích hoạt sớm nhất (như D3a/D3b, bắt buộc có).
--   Hậu kiểm: phiên bản +1, đúng một sự kiện ROUTE_CHANGED ON→SHADOW, danh tính trống, đóng băng giữ nguyên.
--
-- AN TOÀN CHẠY LẠI: đã SHADOW ⇒ bỏ qua; đã OFF (đã qua R1, hoặc chưa từng bật) ⇒ bỏ qua — không ném, để CI
--   dán hai lượt lên production ở bất kỳ bước lùi nào sau đó vẫn xanh. CANARY ⇒ dừng (Đợt 3 không dùng).
--   Công ty thật vắng (Restore Drill) ⇒ bỏ qua như D3a/D3b.
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
--   Chỉ lùi D3b: R7b (hoặc R7a → R7b → R7c) rồi R6.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r7b$
DECLARE
  c_org   constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa  constant text := 'shareholder_profit.ledger_payout.v1';
  c_ly_do constant text := 'R7b (bản lùi Đợt 3b): về chế độ chuẩn bị — thôi chi theo sổ tổng';
  f       app_private.server_feature_flags%ROWTYPE;
  g       app_private.server_feature_flags%ROWTYPE;
  v_actor uuid;
  v_ver   bigint;
  v_n     integer;
  v_so    text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    RAISE NOTICE 'R7b: không có công ty thật (database dùng một lần) — bỏ qua';
    RETURN;
  END IF;
  -- Thứ tự khoá G v2: công ty trước (chặn lập / duyệt phiếu sổ tổng chen giữa tiền kiểm và lúc đổi công tắc).
  IF app_private.lock_org_for_decision_v1(c_org) IS NULL THEN
    RAISE EXCEPTION 'R7B_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R7B_CONG_TAC: thiếu công tắc % (Đợt 1 chưa áp)', c_khoa USING ERRCODE = '55000';
  END IF;
  IF f.mode = 'SHADOW' THEN
    RAISE NOTICE 'R7b: công tắc đã ở SHADOW — bỏ qua';
    RETURN;
  END IF;
  IF f.mode = 'OFF' THEN
    RAISE NOTICE 'R7b: công tắc đã OFF (đã qua R1 hoặc chưa từng bật) — bỏ qua';
    RETURN;
  END IF;
  IF f.mode <> 'ON' THEN
    RAISE EXCEPTION 'R7B_CONG_TAC: công tắc đang % — bản lùi chỉ đưa ON về SHADOW', f.mode USING ERRCODE = '55000';
  END IF;

  SELECT count(*), string_agg(COALESCE(ie.code, ie.id::text), ', ' ORDER BY ie.created_at, ie.id)
    INTO v_n, v_so
    FROM public.income_expenses ie
   WHERE ie.organization_id = c_org
     AND ie.system_source IN ('profit.ledger_payout', 'profit.manager_salary')
     AND ie.deleted_at IS NULL
     AND ((ie.approval_status = 'UNAPPROVED' AND app_private.profit_ledger_voucher_live_v1(ie.id))
          OR (ie.approval_status = 'APPROVED' AND COALESCE(ie.posting_status, 'UNPOSTED') = 'UNPOSTED'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'R7B_PHIEU_KET: còn % phiếu chi theo sổ tổng chờ duyệt / đã duyệt chưa ghi sổ (%) — về SHADOW thì không duyệt / ghi sổ được nữa: duyệt + ghi sổ khi còn ON, hoặc huỷ có lý do (chạy được cả khi đóng băng) hết rồi mới chạy R7b',
      v_n, v_so USING ERRCODE = '55000';
  END IF;

  SELECT m.user_id INTO v_actor
    FROM public.organization_memberships m
    JOIN public.role_bindings rb ON rb.membership_id = m.id
    JOIN public.organization_roles vai ON vai.id = rb.role_id AND vai.organization_id = m.organization_id
   WHERE m.organization_id = c_org
     AND m.status = 'ACTIVE'
     AND m.activated_at IS NOT NULL
     AND (m.valid_to IS NULL OR m.valid_to > now())
     AND (rb.valid_from IS NULL OR rb.valid_from <= now())
     AND (rb.valid_to IS NULL OR rb.valid_to > now())
     AND vai.system_key = 'TENANT_OWNER'
     AND vai.status = 'ACTIVE'
   ORDER BY m.activated_at, m.user_id
   LIMIT 1;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'R7B_ACTOR: không tìm thấy tài khoản chủ (vai TENANT_OWNER, đã kích hoạt)' USING ERRCODE = '55000';
  END IF;

  v_ver := app_private.set_feature_route_v1(c_khoa, f.config_version, 'SHADOW', NULL, NULL, 0, 0, 0,
             NULL, NULL, NULL, NULL, v_actor, c_ly_do);

  SELECT * INTO g FROM app_private.server_feature_flags WHERE feature_key = c_khoa;
  IF v_ver IS DISTINCT FROM f.config_version + 1 OR g.config_version IS DISTINCT FROM v_ver
     OR g.mode IS DISTINCT FROM 'SHADOW' OR g.force_freeze IS DISTINCT FROM f.force_freeze
     OR g.commit_sha IS NOT NULL OR g.migration_sha256 IS NOT NULL
     OR g.maintenance_window_id IS NOT NULL OR g.approval_reference IS NOT NULL
     OR (app_private.evaluate_feature_route(c_khoa, c_org)
         IS DISTINCT FROM (CASE WHEN f.force_freeze THEN 'FROZEN' ELSE 'SHADOW' END))
     OR (SELECT count(*) FROM app_private.server_feature_flag_events e
          WHERE e.feature_key = c_khoa AND e.event_type = 'ROUTE_CHANGED' AND e.before_mode = 'ON'
            AND e.after_mode = 'SHADOW' AND e.after_version = v_ver AND e.actor = v_actor) <> 1 THEN
    RAISE EXCEPTION 'R7B_SAU: hậu kiểm về SHADOW sai' USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'R7b: ON → SHADOW (config_version % → %)', f.config_version, v_ver;
END
$r7b$;

COMMIT;
