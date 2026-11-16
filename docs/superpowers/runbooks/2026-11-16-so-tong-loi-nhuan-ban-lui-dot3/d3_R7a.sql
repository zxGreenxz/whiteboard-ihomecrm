-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R7a: ĐÓNG BĂNG KHẨN CẤP công tắc shareholder_profit.ledger_payout.v1.
--
-- DÙNG KHI
--   Cần dừng NGAY mọi bước tiền theo sổ tổng sau Đợt 3b (20261115113532). Route thành FROZEN:
--   E5 / E9 / E11 / E16 và DUYỆT / GHI SỔ phiếu chi theo sổ tổng (F1) trả 55000 PROFIT_LEDGER_FROZEN;
--   huỷ phiếu có lý do (E6) và mọi màn đọc vẫn chạy. Không đổi chế độ (mode), không đổi số tiền nào.
--
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Không có "nút" đóng băng: R7a cũng đi lane.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_dong_bang   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- LÀM GÌ
--   force_freeze = true + đúng một sự kiện FORCE_FREEZE. Người ghi = tài khoản chủ (vai TENANT_OWNER, thành
--   viên ACTIVE, kích hoạt sớm nhất — cùng cách chọn của D3a). Không tìm được chủ thì VẪN đóng băng: sự kiện
--   ghi actor NULL và detail.actor_missing = true (đóng băng khẩn không chờ tra người). Hậu kiểm route FROZEN.
--
-- AN TOÀN CHẠY LẠI (lane và CI dán hai lượt trong một giao dịch): đang đóng băng ⇒ bỏ qua, không ghi gì.
--   Công ty thật vắng (Restore Drill, database dùng một lần) ⇒ bỏ qua như D3a/D3b (công tắc ở đó vẫn OFF).
-- GỠ: R7c.
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r7a$
DECLARE
  c_org   constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa  constant text := 'shareholder_profit.ledger_payout.v1';
  c_ly_do constant text := 'R7a: đóng băng khẩn cấp sổ tổng lợi nhuận';
  f       app_private.server_feature_flags%ROWTYPE;
  g       app_private.server_feature_flags%ROWTYPE;
  v_actor uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    RAISE NOTICE 'R7a: không có công ty thật (database dùng một lần) — bỏ qua';
    RETURN;
  END IF;

  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R7A_CONG_TAC: thiếu công tắc % (Đợt 1 chưa áp)', c_khoa USING ERRCODE = '55000';
  END IF;
  IF f.force_freeze THEN
    RAISE NOTICE 'R7a: công tắc đã đóng băng — bỏ qua';
    RETURN;
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
    RAISE NOTICE 'R7a: không tìm thấy tài khoản chủ (TENANT_OWNER đã kích hoạt) — vẫn đóng băng, sự kiện ghi actor NULL';
  END IF;

  UPDATE app_private.server_feature_flags
     SET force_freeze = true,
         reason = c_ly_do,
         updated_by = v_actor,
         updated_at = clock_timestamp()
   WHERE feature_key = c_khoa;

  INSERT INTO app_private.server_feature_flag_events
    (feature_key, event_type, before_mode, after_mode, before_version, after_version, detail, actor)
  VALUES
    (c_khoa, 'FORCE_FREEZE', f.mode, f.mode, f.config_version, f.config_version,
     jsonb_build_object('reason', c_ly_do, 'step', 'R7a', 'actor_missing', v_actor IS NULL), v_actor);

  -- Hậu kiểm: đóng băng, chế độ và phiên bản cấu hình không đổi, route FROZEN.
  SELECT * INTO g FROM app_private.server_feature_flags WHERE feature_key = c_khoa;
  IF NOT g.force_freeze OR g.mode IS DISTINCT FROM f.mode OR g.config_version IS DISTINCT FROM f.config_version
     OR app_private.evaluate_feature_route(c_khoa, c_org) <> 'FROZEN' THEN
    RAISE EXCEPTION 'R7A_SAU: hậu kiểm đóng băng sai (route chưa FROZEN hoặc công tắc bị đổi thêm)' USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'R7a: đã đóng băng (mode %, config_version %)', f.mode, f.config_version;
END
$r7a$;

COMMIT;
