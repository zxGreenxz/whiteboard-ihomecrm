-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R1: công tắc shareholder_profit.ledger_payout.v1 SHADOW → OFF (về đường cũ
-- LEGACY; lùi X1 của Đợt 3a, 20261115113530). BƯỚC CUỐI của lùi toàn phần.
--
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_ve_off   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- TIỀN KIỂM (dừng 55000, không ghi gì):
--   R1_CONG_TAC  công tắc không ở SHADOW (ON/CANARY ⇒ chạy R7a → R7b → R7c trước);
--   R1_DONG_BANG còn đóng băng (OFF mà vẫn đóng băng thì route vẫn FROZEN) ⇒ chạy R7c trước;
--   R1_R6        còn policy X5 (ở LEGACY web cũ đọc thẳng ba bảng) ⇒ chạy R6 trước;
--   R1_MOC       còn mốc Đợt 3a đang hiệu lực ⇒ chạy R3 trước (hàm đặt mốc không chạy ở LEGACY, sau R1 hết gỡ);
--   R1_PHIEU_KET còn phiếu chi theo sổ tổng (profit.ledger_payout / profit.manager_salary) CHỜ DUYỆT hoặc ĐÃ DUYỆT
--                CHƯA GHI SỔ (lọt qua R7b: R7b đã bỏ qua vì công tắc về SHADOW từ trước, hoặc phiếu bị từ chối được
--                gửi duyệt lại sau R7b): chốt F1 chỉ cho duyệt / ghi sổ khi CANONICAL ⇒ ở SHADOW / LEGACY phiếu kẹt.
--                Câu báo kèm số phiếu; huỷ có lý do (E6 — chạy ở mọi route) hết rồi mới chạy R1 (muốn chi thật thì
--                phải bật lại ON bằng migration mới);
--   R1_ACTOR     không có tài khoản chủ TENANT_OWNER đã kích hoạt (người ghi như D3a).
-- LÀM GÌ: app_private.set_feature_route_v1(…, 'OFF', danh tính NULL) — CAS theo config_version đọc lúc chạy.
--   Hậu kiểm: phiên bản +1, đúng một sự kiện ROUTE_CHANGED SHADOW→OFF của người ghi, route LEGACY.
-- AN TOÀN CHẠY LẠI: đã OFF ⇒ bỏ qua trước mọi tiền kiểm (lượt hai; CI dán hai lượt sau khi đã áp vẫn xanh).
--   Công ty thật vắng (Restore Drill) ⇒ bỏ qua như D3a/D3b (công tắc ở đó vẫn OFF).
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- ÁP LẠI D3a SAU KHI LÙI: migration MỚI — tạo lại app_private.profit_ledger_luong_backfill_v1 đúng thân M3
--   (20261115083422; md5 prosrc bỏ CR 7ce5d543f3cb2937a2322fb44d664690 — production đã dọn hàm ở 20261115213226)
--   + REVOKE ALL; D3a với khoá mốc MỚI bắt đầu bằng 'd3a-' (R3/R1 nhận mốc Đợt 3a theo tiền tố này); rồi dọn hàm lại.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r1$
DECLARE
  c_org    constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa   constant text := 'shareholder_profit.ledger_payout.v1';
  c_op     constant text := 'shareholder_profit.ledger_marker.v1';
  c_ly_do  constant text := 'R1 (bản lùi Đợt 3a): về đường cũ (LEGACY)';
  f        app_private.server_feature_flags%ROWTYPE;
  g        app_private.server_feature_flags%ROWTYPE;
  v_actor  uuid;
  v_ver    bigint;
  v_n      integer;
  v_so     text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    RAISE NOTICE 'R1: không có công ty thật (database dùng một lần) — bỏ qua';
    RETURN;
  END IF;
  -- Thứ tự khoá G v2: công ty trước (chặn lập / duyệt phiếu sổ tổng chen giữa tiền kiểm và lúc tắt).
  IF app_private.lock_org_for_decision_v1(c_org) IS NULL THEN
    RAISE EXCEPTION 'R1_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R1_CONG_TAC: thiếu công tắc % (Đợt 1 chưa áp)', c_khoa USING ERRCODE = '55000';
  END IF;
  IF f.mode = 'OFF' THEN
    RAISE NOTICE 'R1: công tắc đã OFF — bỏ qua';
    RETURN;
  END IF;
  IF f.mode <> 'SHADOW' THEN
    RAISE EXCEPTION 'R1_CONG_TAC: công tắc đang % — chạy R7a → R7b → R7c trước (R1 chỉ đưa SHADOW về OFF)', f.mode
      USING ERRCODE = '55000';
  END IF;
  IF f.force_freeze THEN
    RAISE EXCEPTION 'R1_DONG_BANG: công tắc đang đóng băng — chạy R7c trước' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
              WHERE p.policyname IN ('profit_alloc_self_select', 'bldg_sh_self_select', 'profit_monthly_self_select')
                AND p.qual LIKE '%profit_viewer_can_v1%') THEN
    RAISE EXCEPTION 'R1_R6: còn policy X5 — chạy R6 trước (ở LEGACY web cũ đọc thẳng ba bảng)' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_n
    FROM (SELECT DISTINCT mk.subject_kind, mk.subject_id
            FROM app_private.profit_ledger_markers mk
            JOIN app_private.canonical_write_operations o
              ON o.organization_id = mk.organization_id AND o.operation = c_op AND o.subject_id = mk.id
           WHERE mk.organization_id = c_org AND o.idempotency_key LIKE 'd3a-%') c
    CROSS JOIN LATERAL app_private.profit_ledger_active_marker_v1(c_org, c.subject_kind, c.subject_id) hien
    JOIN app_private.canonical_write_operations o2
      ON o2.organization_id = c_org AND o2.operation = c_op AND o2.subject_id = hien.marker_id
     AND o2.idempotency_key LIKE 'd3a-%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'R1_MOC: còn % mốc Đợt 3a đang hiệu lực — chạy R3 trước (sau R1 hàm đặt mốc không chạy nữa)', v_n
      USING ERRCODE = '55000';
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
    RAISE EXCEPTION 'R1_PHIEU_KET: còn % phiếu chi theo sổ tổng chờ duyệt / đã duyệt chưa ghi sổ (%) — ngoài CANONICAL không duyệt / ghi sổ được: huỷ có lý do hết rồi mới chạy R1 (muốn chi thật thì bật lại ON bằng migration mới)',
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
    RAISE EXCEPTION 'R1_ACTOR: không tìm thấy tài khoản chủ (vai TENANT_OWNER, đã kích hoạt)' USING ERRCODE = '55000';
  END IF;

  v_ver := app_private.set_feature_route_v1(c_khoa, f.config_version, 'OFF', NULL, NULL, 0, 0, 0,
             NULL, NULL, NULL, NULL, v_actor, c_ly_do);

  SELECT * INTO g FROM app_private.server_feature_flags WHERE feature_key = c_khoa;
  IF v_ver IS DISTINCT FROM f.config_version + 1 OR g.config_version IS DISTINCT FROM v_ver
     OR g.mode IS DISTINCT FROM 'OFF' OR g.force_freeze
     OR app_private.evaluate_feature_route(c_khoa, c_org) <> 'LEGACY'
     OR (SELECT count(*) FROM app_private.server_feature_flag_events e
          WHERE e.feature_key = c_khoa AND e.event_type = 'ROUTE_CHANGED' AND e.before_mode = 'SHADOW'
            AND e.after_mode = 'OFF' AND e.after_version = v_ver AND e.actor = v_actor) <> 1 THEN
    RAISE EXCEPTION 'R1_SAU: hậu kiểm về OFF sai (route chưa LEGACY)' USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'R1: SHADOW → OFF (config_version % → %), route LEGACY', f.config_version, v_ver;
END
$r1$;

COMMIT;
