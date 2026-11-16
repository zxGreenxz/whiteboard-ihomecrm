-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R3: gỡ các mốc "đã trả đủ" do Đợt 3a (20261115113530) đặt.
--
-- DÙNG KHI: lùi toàn phần Đợt 3a. PHẢI chạy khi công tắc đã về SHADOW (sau R7b; còn đóng băng thì R7c trước) và
--   TRƯỚC R1: gỡ mốc khi còn ON (CANONICAL) làm số dư được phép chi nhảy lên trong lúc lệnh chi / duyệt vẫn chạy;
--   hàm đặt mốc không chạy ở LEGACY (R1 tự dừng nếu còn mốc Đợt 3a) và không chạy khi đóng băng.
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_go_moc   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- LÀM GÌ
--   Mốc Đợt 3a = dòng mốc do app_private.profit_ledger_tao_set_marker_v1 ghi với khoá idempotency 'd3a-…'
--   (app_private.canonical_write_operations, operation shareholder_profit.ledger_marker.v1). Với mỗi chủ thể từng
--   có mốc Đợt 3a, xét mốc Đợt 3a MỚI NHẤT của chủ thể (chuỗi mốc là đường thẳng, mỗi mốc bị đè nhiều nhất một lần):
--     - chưa bị đè (đang hiệu lực) ⇒ gỡ: đặt mốc tháng NULL đè ĐÚNG mốc đó (CAS), khoá 'r3-go-moc-<id mốc Đợt 3a>'
--       — mỗi mốc bị gỡ một khoá riêng, nên lần lùi sau một lần áp lại D3a không bao giờ trả "kết quả cũ";
--     - đứng sau nó trong chuỗi có một mốc tháng NULL (mốc gỡ của R3, hoặc chủ đã tự gỡ qua E9) ⇒ đã xong, bỏ qua
--       — kể cả khi chủ đặt mốc mới SAU đó (chạy lại / CI dán hai lượt không dừng giả);
--     - bị mốc CÓ THÁNG khác đè (chủ đặt qua E9 sau Đợt 3a, trước R3) mà sau đó chưa có mốc tháng NULL ⇒ DỪNG
--       R3_MOC_KHAC, không ghi gì: R3 không tự gỡ mốc của chủ — hỏi chủ; chủ muốn lùi thì tự gỡ mốc của mình qua
--       E9 (tháng NULL) rồi chạy lại R3.
--   Mốc Đợt 3a đè lên một mốc CÓ THÁNG đặt trước Đợt 3a ⇒ DỪNG R3_MOC_TRUOC_D3A: đặt lại tháng cũ sinh ledger_seq /
--   created_at mới nên loại oan các phiếu chi lập sau mốc cũ (số dư phồng không báo) — xử lý tay. Production không
--   có ca này (công tắc OFF từ Đợt 1 tới D3a nên không có mốc nào trước D3a).
--   Gỡ mốc làm số dư tính lại từ đầu sổ: chủ thể đang ÂM (đã chi tạm ứng sau Đợt 3a) thì hàm đặt mốc coi là xoá
--   dấu tạm ứng ⇒ R3 kiểm TRƯỚC mọi lần ghi và DỪNG R3_TAM_UNG (không tự xác nhận). Chỉ khi chủ đồng ý bằng văn bản
--   mới đổi c_xac_nhan_xoa_tam_ung = true (số xoá dấu ghi vào mốc mới và nhật ký MARKER_SET).
--   Route: FROZEN ⇒ R3_DONG_BANG; CANONICAL / LEGACY ⇒ R3_ROUTE. Người ghi = tài khoản chủ TENANT_OWNER kích hoạt
--   sớm nhất (như D3a), phải có quyền distribute + pay_manager.
--   Hậu kiểm: mốc hiện hành của từng chủ thể đúng là mốc vừa đặt (đè đúng mốc Đợt 3a, tháng NULL); toàn công ty
--   không còn mốc Đợt 3a nào đang hiệu lực. Dòng mốc cũ ở lại (sổ chỉ ghi thêm).
--
-- AN TOÀN CHẠY LẠI: không còn mốc Đợt 3a nào phải gỡ ⇒ bỏ qua, không ghi gì (kể cả khi đã về LEGACY sau R1).
--   Công ty thật vắng (Restore Drill) ⇒ bỏ qua như D3a/D3b.
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r3$
DECLARE
  c_org      constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa     constant text := 'shareholder_profit.ledger_payout.v1';
  c_op       constant text := 'shareholder_profit.ledger_marker.v1';
  c_ly_do    constant text := 'R3 (bản lùi Đợt 3a): gỡ mốc "đã trả đủ" do migration 20261115113530 đặt — sổ về như trước chuyển đổi';
  -- KHÔNG đổi nếu chưa có quyết định bằng văn bản của chủ (xem đầu tệp).
  c_xac_nhan_xoa_tam_ung constant boolean := false;
  v_route    text;
  v_actor    uuid;
  v_ok_chia  boolean;
  v_ok_luong boolean;
  v_ke_hoach jsonb := '[]'::jsonb;
  v_xong     integer := 0;
  v_khac     text;
  v_truoc    text;
  v_tam_ung  text;
  v_sd       jsonb;
  v_kq       jsonb;
  v_moi      record;
  r          record;
  x          jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    RAISE NOTICE 'R3: không có công ty thật (database dùng một lần) — bỏ qua';
    RETURN;
  END IF;
  -- Thứ tự khoá G v2: công ty trước mọi khoá khác; giữ tới hết giao dịch (không ai đặt mốc chen giữa).
  IF app_private.lock_org_for_decision_v1(c_org) IS NULL THEN
    RAISE EXCEPTION 'R3_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;

  -- Mốc Đợt 3a mới nhất của mỗi chủ thể, mốc đã đè lên nó (nếu có) và tháng của mốc mà nó đè.
  FOR r IN
    WITH d3a AS (
      SELECT mk.id, mk.subject_kind, mk.subject_id, mk.supersedes_id, mk.ledger_seq
        FROM app_private.profit_ledger_markers mk
        JOIN app_private.canonical_write_operations o
          ON o.organization_id = mk.organization_id AND o.operation = c_op AND o.subject_id = mk.id
       WHERE mk.organization_id = c_org AND o.idempotency_key LIKE 'd3a-%'
    ), moi_nhat AS (
      SELECT DISTINCT ON (d3a.subject_kind, d3a.subject_id) d3a.*
        FROM d3a
       ORDER BY d3a.subject_kind, d3a.subject_id, d3a.ledger_seq DESC
    )
    SELECT n.subject_kind AS kind, n.subject_id AS sid, n.id AS moc_d3a,
           (SELECT p.settled_through_month FROM app_private.profit_ledger_markers p WHERE p.id = n.supersedes_id) AS thang_truoc,
           de.id AS de_id,
           EXISTS (SELECT 1 FROM app_private.profit_ledger_markers g
                    WHERE g.organization_id = c_org AND g.subject_kind = n.subject_kind AND g.subject_id = n.subject_id
                      AND g.ledger_seq > n.ledger_seq AND g.settled_through_month IS NULL) AS da_go
      FROM moi_nhat n
      LEFT JOIN app_private.profit_ledger_markers de ON de.supersedes_id = n.id
     ORDER BY n.subject_kind DESC, n.subject_id
  LOOP
    IF r.de_id IS NULL THEN
      IF r.thang_truoc IS NOT NULL THEN
        v_truoc := concat_ws(', ', v_truoc, r.kind || ':' || md5(r.sid::text));
      END IF;
      v_ke_hoach := v_ke_hoach || jsonb_build_array(jsonb_build_object('kind', r.kind, 'sid', r.sid, 'moc_d3a', r.moc_d3a));
    ELSIF r.da_go THEN
      v_xong := v_xong + 1;
    ELSE
      v_khac := concat_ws(', ', v_khac, r.kind || ':' || md5(r.sid::text));
    END IF;
  END LOOP;

  IF v_khac IS NOT NULL THEN
    RAISE EXCEPTION 'R3_MOC_KHAC: mốc Đợt 3a của một số chủ thể đã bị mốc có tháng khác đè (chủ đặt sau Đợt 3a) — R3 không tự gỡ mốc của chủ; hỏi chủ: muốn lùi thì chủ tự gỡ mốc của mình (tháng NULL) qua E9 rồi chạy lại R3'
      USING ERRCODE = '55000', DETAIL = v_khac;
  END IF;
  IF v_truoc IS NOT NULL THEN
    RAISE EXCEPTION 'R3_MOC_TRUOC_D3A: mốc Đợt 3a đè lên một mốc có tháng đặt trước Đợt 3a — đặt lại tháng cũ sẽ loại oan phiếu chi lập sau mốc cũ; xử lý tay'
      USING ERRCODE = '55000', DETAIL = v_truoc;
  END IF;
  IF jsonb_array_length(v_ke_hoach) = 0 THEN
    RAISE NOTICE 'R3: không còn mốc Đợt 3a nào phải gỡ (% chủ thể đã gỡ trước đó) — bỏ qua', v_xong;
    RETURN;
  END IF;

  v_route := app_private.evaluate_feature_route(c_khoa, c_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'R3_DONG_BANG: công tắc đang đóng băng — chạy R7c trước (gỡ mốc cần SHADOW)'
      USING ERRCODE = '55000';
  END IF;
  IF v_route = 'CANONICAL' THEN
    RAISE EXCEPTION 'R3_ROUTE: route đang CANONICAL — chạy R7b (về SHADOW) trước: gỡ mốc khi còn chi theo sổ tổng làm số dư được phép chi nhảy lên'
      USING ERRCODE = '55000';
  END IF;
  IF v_route <> 'SHADOW' THEN
    RAISE EXCEPTION 'R3_ROUTE: route đang % — R3 phải chạy TRƯỚC R1 (gỡ mốc cần SHADOW)', v_route
      USING ERRCODE = '55000';
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
    RAISE EXCEPTION 'R3_ACTOR: không tìm thấy tài khoản chủ (vai TENANT_OWNER, đã kích hoạt)' USING ERRCODE = '55000';
  END IF;
  SELECT a.allowed INTO v_ok_chia
    FROM app_private.authorize_tenant_action_v3(v_actor, c_org, 'shareholder_profit.distribute', NULL, NULL) a;
  SELECT a.allowed INTO v_ok_luong
    FROM app_private.authorize_tenant_action_v3(v_actor, c_org, 'shareholder_profit.pay_manager', NULL, NULL) a;
  IF NOT COALESCE(v_ok_chia, false) OR NOT COALESCE(v_ok_luong, false) THEN
    RAISE EXCEPTION 'R3_ACTOR: tài khoản chủ được chọn không có quyền shareholder_profit.distribute / pay_manager'
      USING ERRCODE = '55000';
  END IF;

  -- Tạm ứng: kiểm hết TRƯỚC khi ghi mốc nào (cùng công thức hàm đặt mốc dùng, tháng NULL = gỡ mốc).
  FOR x IN SELECT t.e FROM jsonb_array_elements(v_ke_hoach) AS t(e) LOOP
    v_sd := app_private.profit_ledger_balance_v1(c_org, x ->> 'kind', (x ->> 'sid')::uuid);
    IF app_private.profit_ledger_tao_advance_erased_v1(c_org, x ->> 'kind', (x ->> 'sid')::uuid,
         NULL, (v_sd ->> 'balance')::numeric) > 0 THEN
      v_tam_ung := concat_ws(', ', v_tam_ung, (x ->> 'kind') || ':' || md5(x ->> 'sid'));
    END IF;
  END LOOP;
  IF v_tam_ung IS NOT NULL AND NOT c_xac_nhan_xoa_tam_ung THEN
    RAISE EXCEPTION 'R3_TAM_UNG: gỡ mốc sẽ xoá dấu khoản tạm ứng đang treo (chủ thể âm sau Đợt 3a) — hỏi chủ; chỉ khi chủ đồng ý bằng văn bản mới đổi c_xac_nhan_xoa_tam_ung = true'
      USING ERRCODE = '55000', DETAIL = v_tam_ung;
  END IF;

  FOR x IN SELECT t.e FROM jsonb_array_elements(v_ke_hoach) AS t(e) LOOP
    v_kq := app_private.profit_ledger_tao_set_marker_v1(c_org, x ->> 'kind', (x ->> 'sid')::uuid,
              NULL, c_ly_do, (x ->> 'moc_d3a')::uuid, c_xac_nhan_xoa_tam_ung,
              'r3-go-moc-' || (x ->> 'moc_d3a'), v_actor);
    SELECT mk.marker_id, mk.settled_through_month INTO v_moi
      FROM app_private.profit_ledger_active_marker_v1(c_org, x ->> 'kind', (x ->> 'sid')::uuid) mk;
    IF v_moi.marker_id IS DISTINCT FROM (v_kq ->> 'marker_id')::uuid
       OR (v_kq ->> 'supersedes_id')::uuid IS DISTINCT FROM (x ->> 'moc_d3a')::uuid
       OR v_moi.settled_through_month IS NOT NULL THEN
      RAISE EXCEPTION 'R3_SAU: gỡ mốc của % không có hiệu lực (mốc hiện hành khác mốc vừa đặt)',
        (x ->> 'kind') || ':' || md5(x ->> 'sid') USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM (SELECT DISTINCT mk.subject_kind, mk.subject_id
              FROM app_private.profit_ledger_markers mk
              JOIN app_private.canonical_write_operations o
                ON o.organization_id = mk.organization_id AND o.operation = c_op AND o.subject_id = mk.id
             WHERE mk.organization_id = c_org AND o.idempotency_key LIKE 'd3a-%') c
      CROSS JOIN LATERAL app_private.profit_ledger_active_marker_v1(c_org, c.subject_kind, c.subject_id) hien
      JOIN app_private.canonical_write_operations o2
        ON o2.organization_id = c_org AND o2.operation = c_op AND o2.subject_id = hien.marker_id
       AND o2.idempotency_key LIKE 'd3a-%') THEN
    RAISE EXCEPTION 'R3_SAU: vẫn còn mốc Đợt 3a đang hiệu lực' USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'R3: đã gỡ % mốc Đợt 3a (% chủ thể đã gỡ từ trước)', jsonb_array_length(v_ke_hoach), v_xong;
END
$r3$;

COMMIT;
