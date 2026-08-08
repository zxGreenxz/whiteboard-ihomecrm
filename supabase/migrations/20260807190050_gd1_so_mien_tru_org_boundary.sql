-- =============================================================================
-- GĐ1 — SỔ ĐĂNG KÝ MIỄN TRỪ biên giới tổ chức
-- (kế hoạch: docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY-V2.md)
--
-- VÌ SAO FILE NÀY PHẢI ĐỨNG RIÊNG VÀ ĐỨNG TRƯỚC.
-- Bản kế hoạch đầu tiên gộp ba thứ vào cùng một migration: tạo bảng miễn trừ,
-- chạy vòng sinh policy theo catalog, và gắn event trigger. Gộp như vậy thì lần
-- chạy đầu tiên generator luôn quét lên một cái sổ RỖNG — không phải rủi ro, mà
-- là điều chắc chắn theo cấu trúc, vì cả ba nằm trong cùng một transaction.
--
-- Hậu quả không phải lý thuyết. Đo trên production bằng vai thật:
--   • profiles — 7/15 dòng mang organization_id KHÔNG nằm trong membership
--     ACTIVE của chính chủ nó, và 0/7 là super admin. Dập boundary vào đây thì
--     tài khoản demo.chunha mất CHÍNH DÒNG PROFILE CỦA MÌNH (own 1 → 0).
--   • ai_providers — bảng global, khoá chính là PRIMARY KEY(provider), không
--     chứa organization_id. Đo: demo.chunha 10 → 0, lọc enabled=true → 0, tức
--     ô chọn model của Copilot rỗng trắng.
--   • ai_copilot_settings — PRIMARY KEY(id boolean) nên toàn cơ sở dữ liệu tối
--     đa 2 dòng. Đo 1 → 0, maybeSingle() trả null.
--
-- Nên: file này CHỈ tạo bảng và gieo hạt. Generator và event trigger ở GĐ5.
-- Test chốt điều đó: src/lib/__tests__/gd1SoMienTruMigration.test.ts từ chối
-- mọi CREATE POLICY / CREATE EVENT TRIGGER xuất hiện trong file này.
--
-- ⚠ TƯ CÁCH CỦA CÁC DÒNG GIEO SẴN.
-- Chúng là ĐỀ XUẤT sinh từ một cuộc rà soát tự động ngày 07/08/2026, KHÔNG phải
-- quyết định của con người. Vì thế decided_by ghi thẳng "CHỜ NGƯỜI PHÊ DUYỆT" và
-- expires_at là hạn thật: gate quá-hạn sẽ tự biến việc "hoãn" thành deadline,
-- thay vì để miễn trừ tạm lặng lẽ hoá vĩnh viễn — đó là cách sổ miễn trừ ở mọi
-- dự án đều hỏng.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO UPDATE.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS app_private.org_boundary_exemptions (
  table_name         text PRIMARY KEY,
  reason             text NOT NULL,
  decided_by         text NOT NULL,
  expires_at         date NOT NULL,
  replacement_policy text NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_private.org_boundary_exemptions IS
  'Bảng CỐ Ý đứng ngoài cơ chế biên giới tổ chức. Mỗi dòng phải có lý do là SỐ ĐO, người quyết định, '
  'và HẠN. Không có hạn thì miễn trừ tạm luôn hoá vĩnh viễn. Generator ở GĐ5 đọc bảng này để bỏ qua.';
COMMENT ON COLUMN app_private.org_boundary_exemptions.reason IS
  'Phải chứa con số đo được (vd "đo: demo.chunha 10 → 0"), không được là lời khai chung chung.';
COMMENT ON COLUMN app_private.org_boundary_exemptions.replacement_policy IS
  'Nếu bảng vẫn cần chặn nhưng bằng cách khác biên giới org, ghi TÊN đường chặn thật ở đây.';

-- ─────────────────────────────────────────────────────────────────────
-- GIEO HẠT — 9 bảng đã phân loại, lý do là số đo.
--
-- expires_at đặt theo mốc giai đoạn sẽ xử lý dứt điểm:
--   2026-09-30 — mốc GĐ6 (nơi vá đường GHI thiếu organization_id)
--   2026-11-30 — mốc GĐ10 (nơi sửa nhãn mô hình sai)
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO app_private.org_boundary_exemptions
  (table_name, reason, decided_by, expires_at, replacement_policy)
VALUES
  ('ai_providers',
   'Bảng global: khoá chính là PRIMARY KEY(provider), không chứa organization_id. đo: demo.chunha 10 → 0, lọc enabled=true → 0 nên ô chọn model của Copilot rỗng trắng.',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-11-30', NULL),

  ('ai_copilot_settings',
   'PRIMARY KEY(id boolean) nên toàn cơ sở dữ liệu tối đa 2 dòng. đo: 1 → 0 nên maybeSingle() trả null.',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-11-30', NULL),

  ('profiles',
   'Nhãn lệch chứ không phải thiếu biên giới: 7/15 dòng mang organization_id không nằm trong membership ACTIVE của chính chủ, 0/7 là super admin. đo: demo.chunha 7 → 0 và MẤT CHÍNH DÒNG CỦA MÌNH (own 1 → 0).',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-11-30',
   'current_visible_owner_ids() / same_team() — đường đọc thật của bảng này là theo NGƯỜI, không theo tổ chức'),

  ('roles',
   'Bản ghi theo người, không theo tổ chức. đo: demo.chunha 7 → 2.',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-11-30',
   'phân quyền theo role binding, không theo organization_id'),

  ('settings',
   'Bản ghi theo người, còn 2 dòng organization_id NULL. useSettings.ts đọc chỉ lọc theo key nên đổi lực lọc là đổi cardinality của maybeSingle() → đúng lớp lỗi PGRST116 trang trắng.',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-11-30', NULL),

  ('ai_chat_threads',
   'Không có DEFAULT, không có trigger autofill, và chatEngine.ts insert không set organization_id → gắn boundary lúc này là chặn chính đường ghi của mình. Phải vá đường ghi trước (GĐ6).',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-09-30', NULL),

  ('ai_chat_messages',
   'Cùng lý do ai_chat_threads: không DEFAULT, không trigger autofill, đường ghi ở chatEngine.ts không set organization_id. Vá đường ghi trước (GĐ6).',
   'ra-soat-tu-dong-07-08-2026 (CHỜ NGƯỜI PHÊ DUYỆT)', DATE '2026-09-30', NULL)

ON CONFLICT (table_name) DO UPDATE
  SET reason             = EXCLUDED.reason,
      decided_by         = EXCLUDED.decided_by,
      expires_at         = EXCLUDED.expires_at,
      replacement_policy = EXCLUDED.replacement_policy;

REVOKE ALL ON TABLE app_private.org_boundary_exemptions FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_so bigint;
  v_thieu bigint;
  v_khong_do bigint;
BEGIN
  SELECT count(*) INTO v_so FROM app_private.org_boundary_exemptions;
  IF v_so < 7 THEN
    RAISE EXCEPTION 'Sổ miễn trừ chỉ có % dòng, chờ ít nhất 7. DỪNG.', v_so;
  END IF;

  -- ai_usage_logs và ai_copilot_entitlements TỪNG nằm trong danh sách đề xuất,
  -- rồi bị loại sau khi đo: cả hai đã được rào sẵn theo chủ sở hữu.
  --   ai_usage_logs           124 dòng / 1 tổ chức · nathan 0 · demo.chunha 0
  --   ai_copilot_entitlements   1 dòng / 1 tổ chức · chủ LÀ super admin · cả hai vai 0
  -- Gắn boundary vào chúng không lấy mất của ai thứ gì (người đọc duy nhất là
  -- super admin, mà công thức có nhánh is_super_admin()). Miễn trừ một bảng
  -- không cần miễn trừ làm cái sổ nói dối về phạm vi của chính nó.
  IF EXISTS (
    SELECT 1 FROM app_private.org_boundary_exemptions
     WHERE table_name IN ('ai_usage_logs','ai_copilot_entitlements')
  ) THEN
    RAISE EXCEPTION 'ai_usage_logs / ai_copilot_entitlements đã đo là KHÔNG rò và gắn boundary không hỏng gì — chúng thuộc nhóm vá an toàn GĐ3, không phải miễn trừ. DỪNG.';
  END IF;

  SELECT count(*) INTO v_thieu
    FROM app_private.org_boundary_exemptions
   WHERE reason IS NULL OR btrim(reason) = ''
      OR decided_by IS NULL OR btrim(decided_by) = ''
      OR expires_at IS NULL;
  IF v_thieu > 0 THEN
    RAISE EXCEPTION '% dòng miễn trừ thiếu lý do/người quyết định/hạn — miễn trừ không hạn là miễn trừ vĩnh viễn. DỪNG.', v_thieu;
  END IF;

  -- Lý do phải chứa số đo. Đây là chốt rẻ nhất chống việc sổ trôi dần thành
  -- một danh sách lời khai không ai kiểm lại được.
  SELECT count(*) INTO v_khong_do
    FROM app_private.org_boundary_exemptions
   WHERE reason !~ '[0-9]';
  IF v_khong_do > 0 THEN
    RAISE EXCEPTION '% dòng miễn trừ có lý do KHÔNG chứa con số đo được. DỪNG.', v_khong_do;
  END IF;

  -- Ba bảng dưới đây không có cột organization_id nên generator không với tới;
  -- gieo chúng vào đây chỉ làm sổ nói dối về phạm vi của chính nó.
  IF EXISTS (
    SELECT 1 FROM app_private.org_boundary_exemptions
     WHERE table_name IN ('permission_definitions','legacy_owner_allowlist','authorization_migration_exceptions')
  ) THEN
    RAISE EXCEPTION 'Sổ chứa bảng không có cột organization_id — chúng thuộc nhóm GĐ7, không phải miễn trừ. DỪNG.';
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK:
--   DROP TABLE IF EXISTS app_private.org_boundary_exemptions;
-- =============================================================================
