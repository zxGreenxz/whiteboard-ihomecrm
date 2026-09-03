-- G2-A — Nền ghi có kiểm soát của Copilot: action registry + policy singleton +
-- sổ hành động chỉ-ghi-thêm + kill switch phạm vi action.
--
-- ĐÂY LÀ NỀN, KHÔNG PHẢI TÍNH NĂNG. Không có RPC ghi nghiệp vụ nào mới trong file
-- này, và cặp writer thu/chi đang chạy trên production (20260830171108) KHÔNG bị
-- đụng tới. Cái được tạo ra là bốn thứ mà mọi action ghi về sau sẽ phải đi qua:
--
--   1. `copilot_action_registry` — nguồn sự thật DUY NHẤT về "Copilot được phép
--      làm gì". Trước file này câu trả lời nằm rải trong TypeScript (danh sách
--      tool) và trong đầu người viết. Một hàng registry buộc mỗi action khai đủ:
--      quyền nào, rủi ro mấy, chạy bằng cơ chế nào, cần đồng ý kiểu gì, xem
--      trước bằng RPC nào, thực thi bằng RPC nào, lùi thế nào.
--
--   2. `copilot_action_policy` — MỘT hàng, là cái van trần rủi ro. G5 sẽ nâng
--      `max_direct_risk` lên 'L5' bằng cách gọi RPC CAS ở dưới, KHÔNG bằng cách
--      viết thêm migration. Van và cột đã có sẵn từ hôm nay chính là lý do G5
--      không phải đổi chữ ký gì.
--
--   3. `copilot_action_ledger` — sổ chỉ-ghi-thêm cho mọi sự kiện của kế hoạch và
--      của action. Trigger chặn UPDATE/DELETE với MỌI vai, kể cả service_role,
--      cùng khuôn với `ai_write_audit` (20260814034600). Sổ mà sửa được thì nó
--      không phải bằng chứng, nó là ghi chú.
--
--   4. Kill switch phạm vi action — hai hàng `copilot_feature_flags`
--      (scope='action') + RPC bật/tắt capability writer + hàm cổng
--      `copilot_action_gate_v1` mà mọi RPC action tương lai gọi NGAY TRƯỚC khi ghi.
--
-- VÌ SAO HAI CHECK THEO HÀNG TRÊN REGISTRY LÀ ĐIỂM NỐI, KHÔNG PHẢI TRANG TRÍ
--   `copilot_action_registry_l5_row_check` nói: một action mà tên RPC thực thi
--   nghe như duyệt / hạch toán / xoá / cấp quyền thì KHÔNG được đăng ký ở mức rủi
--   ro thấp. Muốn đăng ký thì phải khai đúng mặt: risk L5, executor direct_l5_v1,
--   và đồng ý kiểu step_up. Không có đường "khai L3 cho nhanh rồi sửa sau" — CSDL
--   từ chối hàng đó. Đây là chỗ mà chính sách trong `tooling/copilot-action-policy.json`
--   (gate tĩnh, chạy trên TypeScript) có một bản sao ở tầng dữ liệu: gate tĩnh
--   không nhìn thấy hàng ai đó INSERT thẳng vào registry lúc 2 giờ sáng.
--
--   `copilot_action_registry_l6_forbidden` là vế tuyệt đối: sql / secret / deploy
--   / migration / drop / truncate / pg_ không bao giờ được xuất hiện trong tên RPC
--   nào của registry — preview, execute, hay rollback. L6 trong plan là "không
--   bao giờ", nên nó phải là ràng buộc chứ không phải quy ước.
--
-- ĐIỀU FILE NÀY CỐ Ý KHÔNG LÀM
--   Không bật gì cả. Hàng flag của `income_expense.create_draft` được gieo ở trạng
--   thái `disabled`, và điều đó KHÔNG làm chết đường thu/chi đang chạy: tool IE
--   hiện mang cờ `rolloutExempt: true` trong TypeScript nên nó không hỏi flag. Việc
--   chuyển tool đó sang `rolloutKey = 'action:income_expense.create_draft'` là của
--   G2-B, và G2-B mới là chỗ bật cờ lên. Nếu bật cờ ở đây thì hôm nay nó vô nghĩa
--   (không ai đọc) còn ngày mai nó là một cái công tắc đã ở vị trí "mở" trước khi
--   có ai kiểm tra dây.
--
--   Hàng registry của `income_expense.create_draft` thì `enabled = true`, vì
--   registry mô tả THỰC TẠI: đường đó đã live trên production. Hai cột này trả lời
--   hai câu khác nhau — registry hỏi "action này có tồn tại và còn dùng không",
--   flag hỏi "hôm nay có cho chạy không".
--
-- ĐƯỜNG LÙI
--   Mọi thứ ở đây là bảng/hàm MỚI, không có bảng nào bị đổi. Lùi = DROP theo thứ
--   tự ngược (hàm trước, trigger, rồi bảng) + xoá hai hàng flag scope='action'.
--   Không có dữ liệu nghiệp vụ nào phụ thuộc vào chúng tại thời điểm apply.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. REGISTRY — nguồn sự thật của action
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_action_registry (
  action_id             text PRIMARY KEY
    CONSTRAINT copilot_action_registry_action_id_shape
    CHECK (action_id ~ '^[a-z_]+\.[a-z_]+$'),
  version               int NOT NULL DEFAULT 1 CHECK (version > 0),
  label_vi              text NOT NULL CHECK (btrim(label_vi) <> ''),
  permission_key        text NOT NULL CHECK (btrim(permission_key) <> ''),
  risk                  text NOT NULL CHECK (risk IN ('L3', 'L4', 'L5')),
  executor_kind         text NOT NULL
    CHECK (executor_kind IN ('nonce_abi_v1', 'maker_submit_v1', 'direct_l5_v1')),
  consent_required      text NOT NULL CHECK (consent_required IN ('click', 'step_up')),
  preview_rpc           text NOT NULL,
  execute_rpc           text NOT NULL,
  verify_kind           text NOT NULL DEFAULT 'readback' CHECK (btrim(verify_kind) <> ''),
  produces_entity_table text,
  consumes_ref_table    text,
  -- Nullable là CÓ CHỦ Ý (điểm nối #5): phần lớn action v1 lùi bằng thao tác
  -- người dùng trên UI, không bằng RPC. Bắt buộc có RPC lùi sẽ đẻ ra một loạt
  -- hàm rỗng chỉ để thoả ràng buộc — `rollback_note` mới là thứ luôn phải có.
  rollback_rpc          text,
  rollback_note         text NOT NULL DEFAULT '',
  flag_contract_id      text NOT NULL CHECK (btrim(flag_contract_id) <> ''),
  enabled               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Các ràng buộc theo HÀNG đi qua ALTER guard để lượt apply thứ hai không chết
-- 42710, và để một database đã có bảng (từ nhánh khác) vẫn được vá đủ.
DO $rang_buoc$
BEGIN
  -- Tên hàm: chữ thường + gạch dưới, tối đa một dấu chấm schema.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_registry_rpc_name_shape'
       AND conrelid = 'app_private.copilot_action_registry'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD CONSTRAINT copilot_action_registry_rpc_name_shape CHECK (
        preview_rpc ~ '^[a-z0-9_]+(\.[a-z0-9_]+)?$'
        AND execute_rpc ~ '^[a-z0-9_]+(\.[a-z0-9_]+)?$'
        AND (rollback_rpc IS NULL OR rollback_rpc ~ '^[a-z0-9_]+(\.[a-z0-9_]+)?$')
      );
  END IF;

  -- Cờ rollout của một action LÀ chính action đó. Brief khai `flag_contract_id`
  -- (= action_id) thành một cột riêng thay vì suy ra, nên phải có ràng buộc giữ
  -- hai vế bằng nhau: một hàng khai lệch sẽ làm `copilot_action_gate_v1` đi hỏi
  -- cờ của action KHÁC — kill switch bấm một chỗ, tắt một chỗ khác.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_registry_flag_matches_action'
       AND conrelid = 'app_private.copilot_action_registry'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD CONSTRAINT copilot_action_registry_flag_matches_action
      CHECK (flag_contract_id = action_id);
  END IF;

  -- ĐIỂM NỐI #1 — G5 lật `max_direct_risk` sang 'L5' mà không phải sửa bảng này.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_registry_l5_row_check'
       AND conrelid = 'app_private.copilot_action_registry'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD CONSTRAINT copilot_action_registry_l5_row_check CHECK (
        (execute_rpc !~ '(approve|decide|_post_|posting|delete|remove|reverse|grant|revoke|permission|role)')
        OR (risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up')
      );
  END IF;

  -- L6 tuyệt đối: không có mức rủi ro nào mở được cửa này.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_registry_l6_forbidden'
       AND conrelid = 'app_private.copilot_action_registry'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD CONSTRAINT copilot_action_registry_l6_forbidden CHECK (
        execute_rpc !~ '(sql|secret|deploy|migration|drop|truncate|pg_)'
        AND preview_rpc !~ '(sql|secret|deploy|migration|drop|truncate|pg_)'
        AND COALESCE(rollback_rpc, '') !~ '(sql|secret|deploy|migration|drop|truncate|pg_)'
      );
  END IF;
END
$rang_buoc$;

CREATE OR REPLACE FUNCTION app_private.copilot_action_registry_touch_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $f$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS trg_copilot_action_registry_updated_at
  ON app_private.copilot_action_registry;
CREATE TRIGGER trg_copilot_action_registry_updated_at
  BEFORE UPDATE ON app_private.copilot_action_registry
  FOR EACH ROW EXECUTE FUNCTION app_private.copilot_action_registry_touch_v1();

REVOKE ALL ON app_private.copilot_action_registry FROM PUBLIC;
DO $thu_hoi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_registry FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_registry FROM authenticated;
  END IF;
  -- `service_role` không tồn tại trên mọi môi trường (bản khôi phục schema-only
  -- không có nó), nên guard bằng to_regrole thay vì để REVOKE ném.
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_registry FROM service_role;
  END IF;
END
$thu_hoi$;

COMMENT ON TABLE app_private.copilot_action_registry IS
  'Nguon su that cua moi action ghi cua Copilot. Mot hang = mot action da khai day du '
  '(quyen, rui ro, co che thuc thi, kieu dong y, RPC xem truoc/thuc thi/lui). Hai CHECK '
  'theo hang chan viec khai thap rui ro cho thao tac duyet/hach toan/xoa/cap quyen (L5) '
  'va cam tuyet doi sql/secret/deploy/migration/drop/truncate/pg_ (L6).';

-- Seed v1. `enabled = true` vì đường thu/chi nháp ĐÃ chạy trên production
-- (20260830171108 + 20260830183259); registry mô tả thực tại chứ không bật gì mới.
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled
)
VALUES (
  'income_expense.create_draft',
  1,
  'Tạo phiếu thu/chi nháp',
  'income_expenses.create',
  'L4',
  'nonce_abi_v1',
  'click',
  'copilot_preview_income_expense_v1',
  'copilot_execute_income_expense_v1',
  'ie_draft',
  'income_expenses',
  NULL,
  NULL,
  'Xoá mềm phiếu nháp UNAPPROVED/UNPOSTED qua UI thu chi',
  'income_expense.create_draft',
  true
)
ON CONFLICT (action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. POLICY — một hàng, van trần rủi ro (điểm nối #2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_action_policy (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  max_direct_risk         text NOT NULL DEFAULT 'L4'
    CHECK (max_direct_risk IN ('L3', 'L4', 'L5')),
  allowed_roles           text[] NOT NULL DEFAULT ARRAY['superadmin']::text[],
  standing_grants_enabled boolean NOT NULL DEFAULT false,
  revision                bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason                  text NOT NULL DEFAULT '',
  evidence_link           text NOT NULL DEFAULT '',
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $rang_buoc_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_policy_allowed_roles_check'
       AND conrelid = 'app_private.copilot_action_policy'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_policy
      ADD CONSTRAINT copilot_action_policy_allowed_roles_check CHECK (
        cardinality(allowed_roles) > 0
        AND allowed_roles <@ ARRAY['superadmin', 'owner', 'manager', 'staff']::text[]
      );
  END IF;
END
$rang_buoc_policy$;

INSERT INTO app_private.copilot_action_policy (id, reason, evidence_link)
VALUES (
  true,
  'seed mac dinh: tran rui ro L4, chi superadmin',
  'migration:20260903043956_copilot_action_registry_policy_ledger_v1'
)
ON CONFLICT (id) DO NOTHING;

-- Sổ thay đổi policy: chỉ ghi thêm, cùng khuôn `ai_write_audit_bat_bien_v1`.
CREATE TABLE IF NOT EXISTS app_private.copilot_action_policy_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_before bigint,
  revision_after  bigint,
  old             jsonb NOT NULL DEFAULT '{}'::jsonb,
  new             jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor           uuid,
  reason          text NOT NULL DEFAULT '',
  evidence_link   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION app_private.copilot_policy_audit_bat_bien_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $f$
BEGIN
  RAISE EXCEPTION
    'copilot_action_policy_audit chi ghi them: % bi tu choi. Sua mot dong so la sua chinh bang chung.',
    TG_OP
    USING ERRCODE = '42501';
END
$f$;

DROP TRIGGER IF EXISTS trg_copilot_action_policy_audit_bat_bien
  ON app_private.copilot_action_policy_audit;
CREATE TRIGGER trg_copilot_action_policy_audit_bat_bien
  BEFORE UPDATE OR DELETE ON app_private.copilot_action_policy_audit
  FOR EACH ROW EXECUTE FUNCTION app_private.copilot_policy_audit_bat_bien_v1();

REVOKE ALL ON app_private.copilot_action_policy FROM PUBLIC;
REVOKE ALL ON app_private.copilot_action_policy_audit FROM PUBLIC;
DO $thu_hoi_policy$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_policy FROM anon;
    REVOKE ALL ON app_private.copilot_action_policy_audit FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_policy FROM authenticated;
    REVOKE ALL ON app_private.copilot_action_policy_audit FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_policy FROM service_role;
    REVOKE ALL ON app_private.copilot_action_policy_audit FROM service_role;
  END IF;
END
$thu_hoi_policy$;

-- ---------------------------------------------------------------------------
-- 3. LEDGER — sổ hành động chỉ-ghi-thêm (điểm nối #8)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_action_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `plan_id`/`step_no`/`plan_version` nullable ở v1: G3 mới sinh kế hoạch. Một
  -- sự kiện action đơn lẻ (không thuộc kế hoạch nào) vẫn phải vào sổ được.
  plan_id             uuid,
  step_no             int,
  plan_version        int,
  event               text NOT NULL CHECK (event IN (
                        'plan_created', 'plan_approved', 'step_done', 'step_failed',
                        'step_blocked', 'plan_cancelled', 'plan_expired',
                        'action_executed', 'action_failed', 'policy_changed',
                        'capability_changed')),
  user_id             uuid NOT NULL,
  -- Nullable ở tầng cột, nhưng bắt buộc ở tầng CHECK cho MỌI sự kiện trừ
  -- `policy_changed` — xem `copilot_action_ledger_org_required` bên dưới.
  organization_id     uuid,
  action_id           text,
  permission_key      text,
  permission_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_id          uuid,
  consent_kind        text CHECK (consent_kind IS NULL
                        OR consent_kind IN ('click', 'step_up', 'standing_grant')),
  step_up_id          uuid,
  grant_id            uuid,
  payload_digest      bytea,
  before_digest       bytea,
  after_digest        bytea,
  outcome             jsonb,
  error_code          text,
  sqlstate            text,
  entity_table        text,
  entity_id           uuid,
  -- Trỏ tới `public.ai_write_audit.id` nhưng CỐ Ý không có FK: `ai_write_audit`
  -- là bảng chỉ-ghi-thêm có trigger chặn UPDATE/DELETE, và một khoá ngoại từ đây
  -- sẽ bắt mọi INSERT audit phải khoá thêm hàng ở bảng này. Sổ đi kèm không được
  -- phép làm chậm hoặc làm hỏng đường ghi mà nó đang ghi chép.
  audit_id            uuid,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Phòng trường hợp bảng đã tồn tại từ một nhánh cũ với cột NOT NULL. Lệnh này
-- không ném khi cột đã nullable, nên chạy lại được.
ALTER TABLE app_private.copilot_action_ledger
  ALTER COLUMN organization_id DROP NOT NULL;

-- `policy_changed` là sự kiện TOÀN HỆ THỐNG: van trần rủi ro là một hàng duy
-- nhất, không thuộc công ty nào. Ép nó mang một org sẽ buộc người ghi bịa ra
-- một UUID — và một UUID bịa trong sổ bằng chứng còn tệ hơn một ô trống, vì nó
-- trông như dữ liệu thật. Mọi sự kiện KHÁC vẫn bắt buộc có org.
DO $rang_buoc_ledger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_org_required'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      ADD CONSTRAINT copilot_action_ledger_org_required
      CHECK (organization_id IS NOT NULL OR event = 'policy_changed');
  END IF;
END
$rang_buoc_ledger$;

CREATE INDEX IF NOT EXISTS idx_copilot_action_ledger_org_time
  ON app_private.copilot_action_ledger (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_action_ledger_plan_step
  ON app_private.copilot_action_ledger (plan_id, step_no);

CREATE OR REPLACE FUNCTION app_private.copilot_action_ledger_bat_bien_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $f$
BEGIN
  RAISE EXCEPTION
    'copilot_action_ledger chi ghi them: % bi tu choi voi moi vai, ke ca service_role.',
    TG_OP
    USING ERRCODE = '42501';
END
$f$;

DROP TRIGGER IF EXISTS trg_copilot_action_ledger_bat_bien
  ON app_private.copilot_action_ledger;
CREATE TRIGGER trg_copilot_action_ledger_bat_bien
  BEFORE UPDATE OR DELETE ON app_private.copilot_action_ledger
  FOR EACH ROW EXECUTE FUNCTION app_private.copilot_action_ledger_bat_bien_v1();

REVOKE ALL ON app_private.copilot_action_ledger FROM PUBLIC;
DO $thu_hoi_ledger$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_ledger FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_ledger FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_action_ledger FROM service_role;
  END IF;
END
$thu_hoi_ledger$;

COMMENT ON TABLE app_private.copilot_action_ledger IS
  'So chi-ghi-them cho moi su kien ke hoach/action cua Copilot. Trigger chan UPDATE/DELETE '
  'voi moi vai, ke ca service_role. Duong ghi hop le duy nhat la app_private.copilot_ledger_append_v1.';

-- Đường ghi duy nhất vào sổ. Nhận jsonb thay vì 22 tham số vì mỗi loại sự kiện
-- điền một tập cột khác nhau, và một chữ ký 22 tham số sẽ phải đổi mỗi lần G3
-- thêm một trường.
--
-- AI GHI SỔ THÌ SỔ TỰ ĐÓNG DẤU, KHÔNG HỎI NGƯỜI GỌI. Bản trước nhận `user_id`
-- từ payload và chỉ rơi về `auth.uid()` khi thiếu. Đó là một cửa mạo danh nằm
-- sẵn trong đường ghi bằng chứng: một RPC action tương lai lỡ tay chuyển tiếp
-- payload do trình duyệt dựng là ghi được một dòng sổ mang tên người khác. Sổ
-- mà ghi sai người thực hiện thì nó không còn là bằng chứng nữa. Nay `user_id`
-- trong payload bị BỎ QUA hoàn toàn — dấu duy nhất là `auth.uid()`, và không có
-- `auth.uid()` thì không có dòng nào (28000).
CREATE OR REPLACE FUNCTION app_private.copilot_ledger_append_v1(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $ledger_append$
DECLARE
  v_id    uuid;
  v_uid   uuid := auth.uid();
  v_org   uuid := NULLIF(p ->> 'organization_id', '')::uuid;
  v_event text := NULLIF(p ->> 'event', '');
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'copilot_ledger_payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  -- Chỉ `policy_changed` được phép không có tổ chức (van trần rủi ro là hàng
  -- toàn hệ thống); CHECK trên bảng canh vế còn lại.
  IF v_org IS NULL AND v_event IS DISTINCT FROM 'policy_changed' THEN
    RAISE EXCEPTION 'copilot_ledger_organization_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.copilot_action_ledger (
    plan_id, step_no, plan_version, event, user_id, organization_id, action_id,
    permission_key, permission_snapshot, consent_id, consent_kind, step_up_id,
    grant_id, payload_digest, before_digest, after_digest, outcome, error_code,
    sqlstate, entity_table, entity_id, audit_id
  )
  VALUES (
    NULLIF(p ->> 'plan_id', '')::uuid,
    NULLIF(p ->> 'step_no', '')::int,
    NULLIF(p ->> 'plan_version', '')::int,
    v_event,
    v_uid,
    v_org,
    NULLIF(p ->> 'action_id', ''),
    NULLIF(p ->> 'permission_key', ''),
    COALESCE(p -> 'permission_snapshot', '{}'::jsonb),
    NULLIF(p ->> 'consent_id', '')::uuid,
    NULLIF(p ->> 'consent_kind', ''),
    NULLIF(p ->> 'step_up_id', '')::uuid,
    NULLIF(p ->> 'grant_id', '')::uuid,
    -- Digest đi vào dưới dạng hex để hàm gọi không phải tự dựng bytea trong jsonb.
    decode(NULLIF(p ->> 'payload_digest', ''), 'hex'),
    decode(NULLIF(p ->> 'before_digest', ''), 'hex'),
    decode(NULLIF(p ->> 'after_digest', ''), 'hex'),
    p -> 'outcome',
    NULLIF(p ->> 'error_code', ''),
    NULLIF(p ->> 'sqlstate', ''),
    NULLIF(p ->> 'entity_table', ''),
    NULLIF(p ->> 'entity_id', '')::uuid,
    NULLIF(p ->> 'audit_id', '')::uuid
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$ledger_append$;

REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM PUBLIC;
DO $thu_hoi_append$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_ledger_append_v1(jsonb) FROM service_role;
  END IF;
END
$thu_hoi_append$;

-- ---------------------------------------------------------------------------
-- 4. POLICY RPC — đọc và đổi van, CAS theo revision
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_copilot_action_policy_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $doc_policy$
DECLARE
  v_row app_private.copilot_action_policy%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM app_private.copilot_action_policy WHERE id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  -- Bốn trường + revision. `reason`/`evidence_link`/`updated_by` KHÔNG ra ngoài:
  -- chúng là ghi chú vận hành của super admin, không phải trạng thái mà giao diện
  -- người dùng cần để quyết định hiển thị gì.
  RETURN jsonb_build_object(
    'revision', v_row.revision,
    'max_direct_risk', v_row.max_direct_risk,
    'allowed_roles', to_jsonb(v_row.allowed_roles),
    'standing_grants_enabled', v_row.standing_grants_enabled
  );
END
$doc_policy$;

CREATE OR REPLACE FUNCTION public.set_copilot_action_policy_v1(
  p_expected_revision      bigint,
  p_max_direct_risk        text DEFAULT NULL,
  p_allowed_roles          text[] DEFAULT NULL,
  p_standing_grants_enabled boolean DEFAULT NULL,
  p_reason                 text DEFAULT NULL,
  p_evidence_link          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $set_policy$
DECLARE
  v_cu     app_private.copilot_action_policy%ROWTYPE;
  v_moi    app_private.copilot_action_policy%ROWTYPE;
  v_actor  uuid := auth.uid();
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'copilot_policy_not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Lý do và bằng chứng là BẮT BUỘC, không phải lịch sự. Van này quyết định
  -- Copilot được tự ghi tới mức nào; một lần lật không kèm lý do là một lần
  -- không ai truy được vì sao hệ thống đổi hành vi.
  IF COALESCE(btrim(p_reason), '') = '' OR COALESCE(btrim(p_evidence_link), '') = '' THEN
    RAISE EXCEPTION 'policy_reason_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cu FROM app_private.copilot_action_policy WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_revision IS NULL OR v_cu.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'copilot_policy_stale_revision: dang o revision %, nguoi goi mong %',
      v_cu.revision, p_expected_revision
      USING ERRCODE = '40001';
  END IF;

  IF p_max_direct_risk IS NOT NULL AND p_max_direct_risk NOT IN ('L3', 'L4', 'L5') THEN
    RAISE EXCEPTION 'copilot_policy_risk_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_allowed_roles IS NOT NULL
     AND (cardinality(p_allowed_roles) = 0
          OR NOT (p_allowed_roles <@ ARRAY['superadmin', 'owner', 'manager', 'staff']::text[])) THEN
    RAISE EXCEPTION 'copilot_policy_roles_invalid' USING ERRCODE = '22023';
  END IF;

  -- NULL = giữ nguyên. Người gọi chỉ khai trường mình muốn đổi, nên một lần đổi
  -- trần rủi ro không vô tình reset danh sách vai.
  UPDATE app_private.copilot_action_policy
     SET max_direct_risk         = COALESCE(p_max_direct_risk, v_cu.max_direct_risk),
         allowed_roles           = COALESCE(p_allowed_roles, v_cu.allowed_roles),
         standing_grants_enabled = COALESCE(p_standing_grants_enabled, v_cu.standing_grants_enabled),
         revision                = v_cu.revision + 1,
         reason                  = btrim(p_reason),
         evidence_link           = btrim(p_evidence_link),
         updated_by              = v_actor,
         updated_at              = clock_timestamp()
   WHERE id
  RETURNING * INTO v_moi;

  INSERT INTO app_private.copilot_action_policy_audit (
    revision_before, revision_after, old, new, actor, reason, evidence_link
  )
  VALUES (
    v_cu.revision,
    v_moi.revision,
    jsonb_build_object(
      'max_direct_risk', v_cu.max_direct_risk,
      'allowed_roles', to_jsonb(v_cu.allowed_roles),
      'standing_grants_enabled', v_cu.standing_grants_enabled
    ),
    jsonb_build_object(
      'max_direct_risk', v_moi.max_direct_risk,
      'allowed_roles', to_jsonb(v_moi.allowed_roles),
      'standing_grants_enabled', v_moi.standing_grants_enabled
    ),
    v_actor,
    btrim(p_reason),
    btrim(p_evidence_link)
  );

  -- Sổ hành động cũng phải thấy lần lật van này. `copilot_action_policy_audit`
  -- là sổ riêng của policy; `copilot_action_ledger` là dòng thời gian DUY NHẤT
  -- mà G3/G5 đọc để dựng lại "chuyện gì đã xảy ra". Một thay đổi trần rủi ro
  -- không có mặt ở đó thì dòng thời gian có một lỗ đúng ngay chỗ quan trọng
  -- nhất. Không truyền `organization_id`: van là hàng toàn hệ thống.
  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event', 'policy_changed',
    'outcome', jsonb_build_object(
      'revision_before', v_cu.revision,
      'revision_after', v_moi.revision,
      'max_direct_risk', v_moi.max_direct_risk,
      'allowed_roles', to_jsonb(v_moi.allowed_roles),
      'standing_grants_enabled', v_moi.standing_grants_enabled,
      'reason', btrim(p_reason),
      'evidence_link', btrim(p_evidence_link)
    )
  ));

  RETURN jsonb_build_object(
    'revision', v_moi.revision,
    'max_direct_risk', v_moi.max_direct_risk,
    'allowed_roles', to_jsonb(v_moi.allowed_roles),
    'standing_grants_enabled', v_moi.standing_grants_enabled
  );
END
$set_policy$;

REVOKE ALL ON FUNCTION public.get_copilot_action_policy_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text) FROM PUBLIC;
DO $quyen_policy_rpc$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_copilot_action_policy_v1() FROM anon;
    REVOKE ALL ON FUNCTION public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_copilot_action_policy_v1() FROM service_role;
    REVOKE ALL ON FUNCTION public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_copilot_action_policy_v1() FROM authenticated;
    REVOKE ALL ON FUNCTION public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.get_copilot_action_policy_v1() TO authenticated;
    GRANT EXECUTE ON FUNCTION public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text) TO authenticated;
  END IF;
END
$quyen_policy_rpc$;

-- ĐIỂM NỐI #7 — G3 hỏi "vai của người này có được phép chạy kế hoạch không".
-- v1 chỉ trả lời cho superadmin và owner; manager/staff luôn false vì chưa có
-- đường đồng ý (step-up) nào đo được cho họ. Khi G4 dựng step-up thì mở ở ĐÂY,
-- không phải ở từng RPC action.
CREATE OR REPLACE FUNCTION app_private.copilot_plan_role_allowed_v1(p_organization_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $vai$
DECLARE
  v_roles text[];
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT allowed_roles INTO v_roles FROM app_private.copilot_action_policy WHERE id;
  IF v_roles IS NULL THEN
    RETURN false;
  END IF;

  IF 'superadmin' = ANY(v_roles) AND public.is_super_admin() THEN
    RETURN true;
  END IF;

  -- `is_org_owner_v1` sống ở app_private (khong phai public — da kiem trong
  -- baseline/schema.sql), chu ky (p_org uuid, p_user uuid), va no neo vao
  -- role binding system_key='TENANT_OWNER'.
  IF 'owner' = ANY(v_roles)
     AND app_private.is_org_owner_v1(p_organization_id, auth.uid()) THEN
    RETURN true;
  END IF;

  RETURN false;
END
$vai$;

REVOKE ALL ON FUNCTION app_private.copilot_plan_role_allowed_v1(uuid) FROM PUBLIC;
DO $thu_hoi_vai$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_role_allowed_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_role_allowed_v1(uuid) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_role_allowed_v1(uuid) FROM service_role;
  END IF;
END
$thu_hoi_vai$;

-- ---------------------------------------------------------------------------
-- 5. ĐỌC SỔ — chủ sổ thấy dòng của mình, super admin thấy cả tổ chức
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_action_ledger_list_v1(
  p_organization_id uuid,
  p_limit           int DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $doc_so$
DECLARE
  v_actor uuid := auth.uid();
  v_super boolean;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_ket   jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_super := public.is_super_admin();

  -- Ba digest KHÔNG ra ngoài. Chúng là bằng chứng nội bộ để đối chiếu payload,
  -- và một hex 64 ký tự trong tay trình duyệt chỉ mời người ta thử đoán ngược.
  SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'payload_digest' - 'before_digest' - 'after_digest'), '[]'::jsonb)
    INTO v_ket
    FROM (
      SELECT l.*
        FROM app_private.copilot_action_ledger l
       -- Dòng `policy_changed` không thuộc công ty nào (org NULL). Không nhận
       -- chúng ở đây thì chúng nằm trong sổ mà KHÔNG đường nào đọc được — và
       -- chỉ super admin mới lật được van nên chỉ super admin mới thấy.
       WHERE (l.organization_id = p_organization_id
              OR (l.organization_id IS NULL AND v_super))
         AND (v_super OR l.user_id = v_actor)
       ORDER BY l.created_at DESC
       LIMIT v_limit
    ) t;

  RETURN v_ket;
END
$doc_so$;

REVOKE ALL ON FUNCTION public.copilot_action_ledger_list_v1(uuid, int) FROM PUBLIC;
DO $quyen_doc_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_action_ledger_list_v1(uuid, int) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_action_ledger_list_v1(uuid, int) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_action_ledger_list_v1(uuid, int) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_action_ledger_list_v1(uuid, int) TO authenticated;
  END IF;
END
$quyen_doc_so$;

-- ---------------------------------------------------------------------------
-- 6. KILL SWITCH PHẠM VI ACTION
-- ---------------------------------------------------------------------------
-- Trigger v2 (`copilot_feature_flags_bump_revision`, 20260829030000) từ chối mọi
-- INSERT/UPDATE không mang dấu giao dịch này — đó chính là thứ ép mọi thay đổi
-- lúc chạy phải đi qua RPC CAS. Seed trong migration là đường hợp lệ còn lại, nên
-- nó tự khai dấu.
SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
SELECT
  v.scope,
  v.contract_id,
  v.state,
  'seed kill switch pham vi action cho nen ghi co kiem soat G2-A',
  'migration:20260903043956_copilot_action_registry_policy_ledger_v1',
  'migration:20260903043956_copilot_action_registry_policy_ledger_v1'
FROM (VALUES
  ('action', 'income_expense.create_draft', 'disabled'),  -- G2-B moi noi tool IE vao co nay
  ('action', 'copilot.execution_plan'      , 'disabled')   -- G3 dung
) AS v(scope, contract_id, state)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- Công tắc capability của writer thu/chi. Bảng đã có từ 20260830171108 nhưng
-- không có đường tắt nào ngoài SQL tay — nghĩa là trong một sự cố, thứ duy nhất
-- tắt được writer là mở psql lên production.
CREATE OR REPLACE FUNCTION public.set_copilot_writer_capability_v1(
  p_organization_id uuid,
  p_capability_key  text,
  p_enabled         boolean,
  p_reason          text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $capability$
DECLARE
  v_row app_private.copilot_ie_writer_capabilities_v1%ROWTYPE;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'capability_not_permitted' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'capability_reason_required' USING ERRCODE = '22023';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  -- Tổ chức phải có thật: sổ mà mang một org không tồn tại thì dòng đó không
  -- lọc ra được ở bất kỳ màn hình nào về sau.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE app_private.copilot_ie_writer_capabilities_v1 c
     SET enabled    = p_enabled,
         enabled_at = CASE WHEN p_enabled THEN clock_timestamp() ELSE c.enabled_at END
   WHERE c.capability_key = p_capability_key
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability_not_found: %', p_capability_key USING ERRCODE = 'P0002';
  END IF;

  -- Không truyền `user_id`: `copilot_ledger_append_v1` tự đóng dấu `auth.uid()`
  -- và bỏ qua mọi giá trị người gọi đưa vào.
  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event', 'capability_changed',
    'organization_id', p_organization_id,
    'outcome', jsonb_build_object(
      'capability_key', v_row.capability_key,
      'enabled', v_row.enabled,
      'writer_version', v_row.writer_version,
      'reason', btrim(p_reason)
    )
  ));

  RETURN jsonb_build_object(
    'capability_key', v_row.capability_key,
    'enabled', v_row.enabled,
    'writer_version', v_row.writer_version,
    'enabled_at', v_row.enabled_at
  );
END
$capability$;

REVOKE ALL ON FUNCTION public.set_copilot_writer_capability_v1(uuid, text, boolean, text) FROM PUBLIC;
DO $quyen_capability$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.set_copilot_writer_capability_v1(uuid, text, boolean, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.set_copilot_writer_capability_v1(uuid, text, boolean, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.set_copilot_writer_capability_v1(uuid, text, boolean, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.set_copilot_writer_capability_v1(uuid, text, boolean, text) TO authenticated;
  END IF;
END
$quyen_capability$;

-- CỔNG. Mọi RPC action tương lai gọi hàm này NGAY TRƯỚC khi ghi, và dùng
-- `permission_snapshot` nó trả về làm ảnh chụp quyền cho sổ. Bốn cửa:
--   (a) registry (một hàng, khoá chính)
--   (b) cờ kill switch (một hàng, khoá chính)
--   (c) lệnh cấm khẩn cấp của tổ chức
--   (d) phạm vi quyền qua `authorized_scope_v3`
--
-- VÌ SAO (c) PHẢI ĐỨNG TRƯỚC (d), KHÔNG PHẢI SAU — bản trước xếp ngược và vế
-- cấm khẩn cấp là MÃ CHẾT.
--   `authorized_scope_v3` (20260829100000) đã gấp lệnh cấm khẩn cấp vào KẾT QUẢ
--   của chính nó: CTE `emergency` bật lên thì hàm trả `org_wide = false` với hai
--   mảng rỗng. Nên khi một tổ chức đang bị cấm khẩn cấp, cửa phạm vi quyền ném
--   `not_permitted` TRƯỚC, và khối `tenant_emergency_denies` phía sau không bao
--   giờ chạy tới. Hệ quả không phải là mở lỗ — người dùng vẫn bị chặn — mà là
--   NÓI DỐI về lý do: log ghi "thiếu quyền" cho một sự cố mà thật ra ai đó vừa
--   kéo cầu dao khẩn cấp cho cả công ty. Người trực sự cố đọc log đó sẽ đi sửa
--   phân quyền của một người, trong khi thứ cần làm là gỡ lệnh cấm.
--
--   Đổi thứ tự trả lại cho mỗi cửa đúng thông điệp của nó, và rẻ hơn: một EXISTS
--   trên `tenant_emergency_denies` nhẹ hơn hẳn truy vấn đồ thị quyền mà nó thay
--   thế trong đúng những lần bị chặn.
CREATE OR REPLACE FUNCTION app_private.copilot_action_gate_v1(
  p_action_id       text,
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $cong$
DECLARE
  v_reg   app_private.copilot_action_registry%ROWTYPE;
  v_state text;
  v_canary uuid;
  v_het   timestamptz;
  v_co_co boolean;
  v_org_wide boolean;
  v_toa   uuid[];
  v_so    uuid[];
  v_super boolean;
  v_now   timestamptz := now();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  -- (a) Registry: action phải tồn tại và còn bật.
  SELECT * INTO v_reg
    FROM app_private.copilot_action_registry
   WHERE action_id = p_action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_action_disabled: % khong co trong registry', p_action_id
      USING ERRCODE = '42501';
  END IF;
  IF NOT v_reg.enabled THEN
    RAISE EXCEPTION 'copilot_action_disabled: % da tat trong registry', p_action_id
      USING ERRCODE = '42501';
  END IF;

  -- (b) Kill switch: hàng flag scope='action'. Thiếu hàng = tắt, không phải bật —
  -- một action chưa ai gieo cờ là một action chưa ai quyết định cho chạy.
  SELECT f.state, f.canary_org, f.expires_at
    INTO v_state, v_canary, v_het
    FROM public.copilot_feature_flags f
   WHERE f.scope = 'action' AND f.contract_id = v_reg.flag_contract_id;
  v_co_co := FOUND;

  IF NOT v_co_co
     OR v_state NOT IN ('shadow', 'enabled')
     OR (v_canary IS NOT NULL AND v_canary <> p_organization_id)
     OR (v_het IS NOT NULL AND v_het <= v_now) THEN
    RAISE EXCEPTION 'copilot_action_disabled: co action:% dang o trang thai %',
      v_reg.flag_contract_id, COALESCE(v_state, 'thieu-hang')
      USING ERRCODE = '42501';
  END IF;

  -- (c) Lệnh cấm khẩn cấp của tổ chức, hỏi TRƯỚC phạm vi quyền (lý do ở đầu
  -- hàm). `permission_key IS NULL` là lệnh cấm toàn phần — cột đó chính là cách
  -- bảng này nói "cấm mọi quyền".
  IF EXISTS (
    SELECT 1
      FROM app_private.tenant_emergency_denies d
     WHERE d.organization_id = p_organization_id
       AND (d.permission_key IS NULL OR d.permission_key = v_reg.permission_key)
       AND d.active_from <= v_now
       AND (d.expires_at IS NULL OR d.expires_at > v_now)
  ) THEN
    RAISE EXCEPTION 'tenant_emergency_denied: % tren to chuc %',
      v_reg.permission_key, p_organization_id
      USING ERRCODE = '42501';
  END IF;

  -- (d) Phạm vi quyền thật của người gọi trong tổ chức này. Không có lối tắt
  -- super admin: `authorized_scope_v3` là cùng một phép đo mà màn hình dùng, và
  -- cặp writer thu/chi (20260830171108) cũng chỉ hỏi đúng câu này.
  SELECT s.org_wide, s.building_ids, s.cashbook_ids
    INTO v_org_wide, v_toa, v_so
    FROM app_private.authorized_scope_v3(v_reg.permission_key, p_organization_id) s;

  IF NOT FOUND
     OR (NOT COALESCE(v_org_wide, false)
         AND COALESCE(cardinality(v_toa), 0) = 0
         AND COALESCE(cardinality(v_so), 0) = 0) THEN
    RAISE EXCEPTION 'not_permitted: % tren to chuc %', v_reg.permission_key, p_organization_id
      USING ERRCODE = '42501';
  END IF;

  v_super := public.is_super_admin();

  RETURN jsonb_build_object(
    'org_wide', COALESCE(v_org_wide, false),
    'building_count', COALESCE(cardinality(v_toa), 0),
    'cashbook_count', COALESCE(cardinality(v_so), 0),
    'is_super_admin', v_super,
    'flag_state', v_state,
    'registry_version', v_reg.version,
    'checked_at', v_now
  );
END
$cong$;

REVOKE ALL ON FUNCTION app_private.copilot_action_gate_v1(text, uuid) FROM PUBLIC;
DO $thu_hoi_cong$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_action_gate_v1(text, uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_action_gate_v1(text, uuid) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_action_gate_v1(text, uuid) FROM service_role;
  END IF;
END
$thu_hoi_cong$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, chạy được trên database rỗng.
--
-- Khối này CỐ Ý không thử INSERT/UPDATE thật như 20260814034600 làm với
-- `ai_write_audit`: những bảng ở đây đòi `organization_id`/`user_id` có thật, mà
-- Restore Drill replay forward lane lên baseline schema-only thì không có dòng
-- nghiệp vụ nào. Một khối nghiệm thu chết vì thiếu dữ liệu sẽ cuộn ngược cả file
-- và mất luôn mọi object nó vừa tạo.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  -- (1) Ba bảng nền + bảng audit policy.
  FOREACH v_ten IN ARRAY ARRAY[
    'copilot_action_registry',
    'copilot_action_policy',
    'copilot_action_policy_audit',
    'copilot_action_ledger'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'app_private' AND tablename = v_ten
    ) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu bang nen G2-A: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (2) Hai CHECK theo hàng là điểm nối của G3/G5 — thiếu một cái là plan sau
  -- phải sửa lược đồ, đúng thứ file này sinh ra để tránh.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'copilot_action_registry_l5_row_check',
    'copilot_action_registry_l6_forbidden',
    'copilot_action_registry_rpc_name_shape',
    'copilot_action_registry_flag_matches_action',
    'copilot_action_policy_allowed_roles_check',
    'copilot_action_ledger_org_required'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_ten) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu CHECK theo hang: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (3) Ba trigger: hai cái chặn sửa sổ, một cái giữ updated_at.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'trg_copilot_action_registry_updated_at',
    'trg_copilot_action_policy_audit_bat_bien',
    'trg_copilot_action_ledger_bat_bien'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app_private' AND t.tgname = v_ten AND NOT t.tgisinternal
    ) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu trigger: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (4) Hàm phải tồn tại đúng chữ ký — G3 gọi thẳng những chữ ký này.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'app_private.copilot_ledger_append_v1(jsonb)',
    'app_private.copilot_plan_role_allowed_v1(uuid)',
    'app_private.copilot_action_gate_v1(text, uuid)',
    'public.get_copilot_action_policy_v1()',
    'public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text)',
    'public.copilot_action_ledger_list_v1(uuid, integer)',
    'public.set_copilot_writer_capability_v1(uuid, text, boolean, text)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G2-A: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (5) Không hàm nào của file này được anon gọi.
  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'app_private.copilot_ledger_append_v1(jsonb)',
      'app_private.copilot_plan_role_allowed_v1(uuid)',
      'app_private.copilot_action_gate_v1(text, uuid)',
      'public.get_copilot_action_policy_v1()',
      'public.set_copilot_action_policy_v1(bigint, text, text[], boolean, text, text)',
      'public.copilot_action_ledger_list_v1(uuid, integer)',
      'public.set_copilot_writer_capability_v1(uuid, text, boolean, text)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G2-A: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- (6) Phụ thuộc phải có mặt: file này vô nghĩa nếu thiếu chúng, và thà chết ở
  -- đây còn hơn chết lúc một RPC action gọi vào giữa một giao dịch tiền.
  IF to_regprocedure('app_private.authorized_scope_v3(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'authorized_scope_v3 missing — 20260829100000 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'is_org_owner_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regclass('app_private.tenant_emergency_denies') IS NULL THEN
    RAISE EXCEPTION 'tenant_emergency_denies missing — bang nay khong do repo tao';
  END IF;
  IF to_regclass('app_private.copilot_ie_writer_capabilities_v1') IS NULL THEN
    RAISE EXCEPTION 'copilot_ie_writer_capabilities_v1 missing — 20260830171108 phai chay truoc';
  END IF;

  -- (7) Hai hàng kill switch phạm vi action. Đây là lần đọc duy nhất ngoài
  -- catalog, và nó đọc đúng bảng mà file này vừa gieo.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY['income_expense.create_draft', 'copilot.execution_plan']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.copilot_feature_flags f
       WHERE f.scope = 'action' AND f.contract_id = v_ten
    ) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (8) Hàng registry seed phải tồn tại và đúng hình.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'income_expense.create_draft'
       AND risk = 'L4' AND executor_kind = 'nonce_abi_v1' AND consent_required = 'click'
  ) THEN
    RAISE EXCEPTION 'seed registry income_expense.create_draft sai hinh hoac thieu';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
