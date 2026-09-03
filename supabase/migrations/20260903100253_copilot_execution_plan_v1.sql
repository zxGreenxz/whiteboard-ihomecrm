-- G3-T1 — MỨC 2: KẾ HOẠCH THỰC THI + ĐỒNG Ý THEO LÔ (một migration, 6 RPC public).
--
-- ĐÂY LÀ TRÁI TIM CỦA GIAI ĐOẠN 3. Nó không thêm một hành động ghi nghiệp vụ nào;
-- nó dựng cái KHUNG mà mọi hành động đã đăng ký (G2-A registry) chạy trong đó khi
-- người dùng đồng ý MỘT LẦN cho MỘT DÃY bước:
--
--   copilot_plan_create_v1          lập kế hoạch, xem trước từng bước, phát MỘT nonce
--   copilot_plan_approve_v1         người thật bấm duyệt → tiêu nonce → APPROVED
--   copilot_plan_execute_step_v1    chạy đúng một bước, tuyến tính, có sổ
--   copilot_plan_get_v1             đọc trạng thái (đã lược bỏ mọi bí mật)
--   copilot_plan_cancel_v1          huỷ kế hoạch chưa chạy hết
--   copilot_plan_reconcile_step_v1  chỗ trống của Mức 3 (điểm nối #6)
--
-- BỐN QUYẾT ĐỊNH THIẾT KẾ ĐÁNG ĐỌC TRƯỚC KHI SỬA FILE NÀY
--
--   1. KHÔNG LƯU NONCE TỪNG BƯỚC. Lúc lập kế hoạch, server gọi `preview_rpc` của
--      từng bước để lấy `canonical` + bản xem trước. Lời gọi đó SINH RA một hàng
--      `copilot_write_confirmations` (đó là ABI của mọi action) — và hàng đó bị
--      XOÁ ngay tại chỗ, theo `nonce_digest` của chính nonce vừa nhận. Giữ lại
--      nghĩa là để tới 8 nonce ghi tiền nằm chờ 5 phút cho một kế hoạch có thể
--      không bao giờ được duyệt. Lúc thực thi, server gọi lại `preview_rpc` để
--      lấy một nonce MỚI sống đúng trong giao dịch đó, so digest với bản đã
--      duyệt, rồi tiêu ngay bằng `execute_rpc`. Nonce của từng bước vì thế không
--      tồn tại ngoài một giao dịch, và không bao giờ đi qua trình duyệt hay ngữ
--      cảnh mô hình. Thứ duy nhất người dùng cầm là nonce CẤP KẾ HOẠCH.
--
--   2. `EXECUTE format('SELECT public.%I($1,$2)', <tên>)` CHỈ NHẬN TÊN TỪ REGISTRY.
--      `copilot_action_registry.preview_rpc/execute_rpc` có CHECK regex
--      `^[a-z0-9_]+(\.[a-z0-9_]+)?$` (20260903043956) cộng hai CHECK theo hàng
--      chặn tên nghe như duyệt/hạch toán/xoá/cấp quyền (chỉ hợp lệ khi khai đúng
--      mặt L5) và cấm tuyệt đối sql/secret/deploy/migration/drop/truncate/pg_
--      (L6). Không có đường nào để một chuỗi từ client đi vào `format()` trong
--      file này: mọi tham số `p_*` chỉ được dùng làm THAM SỐ ($1/$2), không bao
--      giờ làm mảnh định danh. Test `copilotExecutionPlanMigration.test.ts` ghim
--      đúng điều đó: không dòng `format(` nào được chứa một biến `p_`.
--
--   3. SỔ PHẢI SỐNG SÓT QUA CUỘN NGƯỢC CỦA BƯỚC HỎNG. `execute_step` bọc
--      preview + execute + đọc lại trong MỘT khối con `BEGIN … EXCEPTION WHEN
--      OTHERS`. Khi bước hỏng, khối con cuốn sạch hiệu ứng ghi — đúng thứ ta
--      muốn — nhưng nếu dòng sổ cũng nằm trong đó thì bằng chứng về lần hỏng
--      cũng biến mất cùng. Nên khối con CHỈ bắt lỗi và ghi lại SQLSTATE/thông
--      điệp vào biến; mọi cập nhật trạng thái và mọi dòng sổ được ghi ở giao
--      dịch NGOÀI, sau khi khối con kết thúc. Biến PL/pgSQL không bị cuộn ngược
--      theo khối con — đó là cơ chế làm việc này chạy được.
--
--   4. CHUYỂN TRẠNG THÁI ĐÃ XẢY RA THÌ KHÔNG RAISE. Hai nhánh — kế hoạch hết hạn,
--      và bước mất quyền lúc duyệt — vừa phải GHI LẠI (EXPIRED/FAILED + sổ) vừa
--      phải BÁO cho người gọi. Trong một giao dịch, `RAISE` cuốn ngược chính cái
--      ghi đó; hai yêu cầu loại trừ nhau. File này chọn GHI, rồi `RETURN` một kết
--      quả mang `status` cuối và `error_code` (`plan_expired`,
--      `step_not_permitted`). Client đọc `status`/`error_code` chứ không đọc
--      exception. Đây là sai lệch CÓ CHỦ Ý so với brief (brief viết "→ EXPIRED +
--      plan_expired") và lý do nằm ở đây, không ở đâu khác: một sổ bằng chứng
--      trống rỗng đúng vào lúc hệ thống từ chối là thứ tệ hơn một mã lỗi khác kiểu.
--      Mọi nhánh KHÔNG cần ghi gì (thiếu quyền, sai nonce, sai phiên bản, kế
--      hoạch đang bận) vẫn RAISE như bình thường.
--
-- MÁY TRẠNG THÁI
--   Kế hoạch : DRAFT →(duyệt) APPROVED →(bước cuối DONE) DONE
--              APPROVED →(một bước FAILED/BLOCKED) FAILED
--              DRAFT|APPROVED →(huỷ) CANCELLED
--              DRAFT|APPROVED →(quá hạn, đánh giá lười) EXPIRED
--   Bước     : PENDING → DONE | FAILED | BLOCKED | SKIPPED | UNKNOWN_EFFECT
--   Mỗi lần chuyển: `version + 1` (CAS) + dòng tương ứng trong `copilot_action_ledger`.
--   Bước tuyến tính: bước k chỉ chạy được khi mọi bước < k đã DONE.
--
-- ĐIỀU FILE NÀY CỐ Ý KHÔNG LÀM
--   · Không gieo hàng registry nào. Đường `maker_submit_v1` (nộp hồ sơ duyệt) đã
--     được hiện thực đầy đủ ở đây, nhưng hàng registry `income_expense.nop_ho_so`
--     thuộc về migration RIÊNG của action đó (luật của repo: mỗi action một
--     migration forward riêng, kèm dòng cờ `disabled` và mục mirror TypeScript).
--     Gieo một hàng L5 trong file dựng khung là trộn hai quyết định khác nhau vào
--     cùng một lần review.
--   · Không seed lại cờ `action:copilot.execution_plan` — 20260903043956 đã gieo
--     nó ở trạng thái `disabled`, và nó phải Ở NGUYÊN đó cho tới đợt rollout T9.
--   · Không mở rộng danh sách `event` của sổ: bảy sự kiện kế hoạch (plan_created,
--     plan_approved, step_done, step_failed, step_blocked, plan_cancelled,
--     plan_expired) đã nằm sẵn trong CHECK của G2-A.
--   · Không đụng `ai_write_audit`, không đụng cặp writer thu/chi, không đụng
--     `submit_financial_voucher`.
--
-- ĐƯỜNG LÙI
--   Mọi thứ là bảng/hàm MỚI. Lùi = DROP 6 RPC public + 3 helper app_private, rồi
--   DROP `copilot_plan_steps` trước `copilot_plans`. Không dữ liệu nghiệp vụ nào
--   phụ thuộc vào chúng: kế hoạch chỉ THAM CHIẾU tới thực thể do action tạo ra.
--
-- NGHIỆM THU chỉ soi catalog nên file chạy được trên database rỗng (Restore Drill
-- replay forward lane lên baseline schema-only).

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. TIỀN ĐỀ — nói to tên file thiếu, thay vì để lỗi hiện ra như "hàm không tồn tại"
-- ---------------------------------------------------------------------------
DO $tien_de$
BEGIN
  IF to_regclass('app_private.copilot_action_registry') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_registry missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regclass('app_private.copilot_action_policy') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_policy missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regclass('app_private.copilot_action_ledger') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_ledger missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regclass('app_private.copilot_write_confirmations') IS NULL THEN
    RAISE EXCEPTION 'copilot_write_confirmations missing — 20260814034500 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_payload_hash_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_payload_hash_v1 missing — 20260814034500 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_plan_role_allowed_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_role_allowed_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.submit_financial_voucher(uuid, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'submit_financial_voucher missing — 20260713130200 phai chay truoc';
  END IF;
  IF to_regclass('public.copilot_feature_flags') IS NULL THEN
    RAISE EXCEPTION 'copilot_feature_flags missing — 20260828170000 phai chay truoc';
  END IF;
END
$tien_de$;

-- ---------------------------------------------------------------------------
-- 1. BẢNG KẾ HOẠCH
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_plans (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Khoá chống-lặp do CLIENT đặt. Một lần bấm "lập kế hoạch" gửi lại vì mạng chập
  -- phải trả về CÙNG kế hoạch, không đẻ kế hoạch thứ hai với cùng 8 bước ghi tiền.
  client_request_id       text NOT NULL,
  status                  text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'APPROVED', 'DONE', 'FAILED', 'CANCELLED', 'EXPIRED')),
  version                 int NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Vân tay của TOÀN BỘ kế hoạch. Giao diện echo lại nó lúc duyệt, nên một kế
  -- hoạch bị đổi ruột giữa lúc xem và lúc bấm sẽ không duyệt được.
  plan_digest             bytea NOT NULL,
  -- Ảnh chụp registry lúc lập: md5 của string_agg(action_id || version).
  registry_revision       text,
  policy_revision         bigint,
  max_risk                text NOT NULL DEFAULT 'L3' CHECK (max_risk IN ('L3', 'L4', 'L5')),
  step_count              int NOT NULL CHECK (step_count BETWEEN 1 AND 8),
  consent_confirmation_id uuid REFERENCES app_private.copilot_write_confirmations(id) ON DELETE SET NULL,
  consent_kind            text CHECK (consent_kind IS NULL
                            OR consent_kind IN ('click', 'step_up', 'standing_grant')),
  -- ĐIỂM NỐI #3/#4 — G5 điền hai cột này khi có step-up PIN và uỷ quyền đứng.
  -- Có sẵn từ hôm nay chính là lý do G5 không phải đổi lược đồ.
  step_up_confirmation_id uuid REFERENCES app_private.copilot_write_confirmations(id) ON DELETE SET NULL,
  standing_grant_ids      uuid[] NOT NULL DEFAULT '{}'::uuid[],
  expires_at              timestamptz NOT NULL,
  approved_at             timestamptz,
  execute_deadline        timestamptz,
  failure_reason          text,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $rang_buoc_plans$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_plans_client_request_unique'
       AND conrelid = 'app_private.copilot_plans'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_plans
      ADD CONSTRAINT copilot_plans_client_request_unique UNIQUE (user_id, client_request_id);
  END IF;

  -- Hình của `client_request_id` được cưỡng chế ở CẢ hai tầng: RPC từ chối sớm để
  -- trả một mã lỗi đọc được, CHECK canh cửa còn lại (ai đó INSERT thẳng).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_plans_client_request_shape'
       AND conrelid = 'app_private.copilot_plans'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_plans
      ADD CONSTRAINT copilot_plans_client_request_shape
      CHECK (client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$');
  END IF;
END
$rang_buoc_plans$;

CREATE INDEX IF NOT EXISTS idx_copilot_plans_user_status
  ON app_private.copilot_plans (user_id, status);
CREATE INDEX IF NOT EXISTS idx_copilot_plans_org_time
  ON app_private.copilot_plans (organization_id, created_at DESC);

COMMENT ON TABLE app_private.copilot_plans IS
  'Ke hoach thuc thi cua Copilot: mot dong y cua nguoi that cho mot day toi da 8 buoc ghi. '
  'plan_digest la van tay cua ca ke hoach; giao dien echo lai no luc duyet nen mot ke hoach '
  'bi doi ruot giua luc xem va luc bam se khong duyet duoc.';

CREATE TABLE IF NOT EXISTS app_private.copilot_plan_steps (
  plan_id        uuid NOT NULL REFERENCES app_private.copilot_plans(id) ON DELETE CASCADE,
  step_no        int NOT NULL CHECK (step_no BETWEEN 1 AND 8),
  action_id      text NOT NULL,
  action_version int NOT NULL DEFAULT 1,
  permission_key text NOT NULL,
  risk           text NOT NULL CHECK (risk IN ('L3', 'L4', 'L5')),
  executor_kind  text NOT NULL,
  -- `payload` là thứ mô hình đề xuất; `canonical` là thứ SERVER chốt ở bước xem
  -- trước. Chỉ `canonical` mới được đem đi ghi, và `payload_digest` băm chính nó.
  payload        jsonb NOT NULL,
  canonical      jsonb,
  payload_digest bytea,
  preview        jsonb,
  status         text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DONE', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNKNOWN_EFFECT')),
  outcome        jsonb,
  error_code     text,
  error_detail   text,
  executed_at    timestamptz,
  ledger_id      uuid,
  -- `maker_submit_v1` với `{$ref_step: n}`: bước này nộp hồ sơ cho thực thể mà
  -- bước n vừa tạo ra. Lưu thành cột riêng để đọc kế hoạch không phải bới jsonb.
  ref_step       int CHECK (ref_step IS NULL OR ref_step BETWEEN 1 AND 8),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plan_id, step_no)
);

COMMENT ON TABLE app_private.copilot_plan_steps IS
  'Mot buoc cua ke hoach. `canonical` do server chot o buoc xem truoc va `payload_digest` bam '
  'chinh no — luc thuc thi server xem truoc LAI va so digest, lech thi bao payload_changed.';

REVOKE ALL ON app_private.copilot_plans FROM PUBLIC;
REVOKE ALL ON app_private.copilot_plan_steps FROM PUBLIC;
DO $thu_hoi_bang$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_plans FROM anon;
    REVOKE ALL ON app_private.copilot_plan_steps FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_plans FROM authenticated;
    REVOKE ALL ON app_private.copilot_plan_steps FROM authenticated;
  END IF;
  -- `service_role` không có ở mọi môi trường (bản khôi phục schema-only không có
  -- nó), nên guard bằng to_regrole thay vì để REVOKE ném.
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_plans FROM service_role;
    REVOKE ALL ON app_private.copilot_plan_steps FROM service_role;
  END IF;
END
$thu_hoi_bang$;

-- ---------------------------------------------------------------------------
-- 2. HELPER app_private
-- ---------------------------------------------------------------------------

-- Cổng rollout phạm vi ACTION, đọc trên SERVER. Cùng khuôn với
-- `copilot_page_flag_allows_v1` (20260903050215) và cùng luật từ chối mặc định:
--   không có hàng cho contract này      → false (contract chưa ai gieo là contract tắt)
--   state 'disabled'                    → false
--   canary_org ghim công ty khác        → false
--   expires_at đã qua                   → false
-- `shadow` được tính là CHO PHÉP vì đó đúng là nghĩa của shadow trong đợt rollout
-- này: bề mặt chạy và được đo, chỉ không quảng cáo. Phía TypeScript vốn hiểu thế;
-- một server hiểu khác sẽ làm cả pha shadow không kiểm được.
--
-- Khác `copilot_action_gate_v1` ở chỗ nào: cổng kia hỏi bốn cửa cho MỘT ACTION
-- (registry + cờ + cấm khẩn cấp + phạm vi quyền) và NÉM khi bị chặn. Hàm này chỉ
-- trả một boolean cho một contract, và nó tồn tại vì `copilot.execution_plan`
-- KHÔNG phải một action trong registry — nó là công tắc của cả cơ chế kế hoạch.
CREATE OR REPLACE FUNCTION app_private.copilot_action_flag_allows_v1(
  p_contract_id     text,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $co_action$
  SELECT EXISTS (
    SELECT 1
      FROM public.copilot_feature_flags f
     WHERE f.scope = 'action'
       AND f.contract_id = p_contract_id
       AND f.state IN ('shadow', 'enabled')
       AND (f.canary_org IS NULL OR f.canary_org = p_organization_id)
       AND (f.expires_at IS NULL OR f.expires_at > now())
  );
$co_action$;

COMMENT ON FUNCTION app_private.copilot_action_flag_allows_v1(text, uuid) IS
  'Cong rollout pham vi action doc tren server; tu choi mac dinh (thieu hang, disabled, het han '
  'hoac canary cua cong ty khac deu tra false). Dung cho contract khong phai action registry, '
  'vi du copilot.execution_plan.';

REVOKE ALL ON FUNCTION app_private.copilot_action_flag_allows_v1(text, uuid) FROM PUBLIC;
DO $thu_hoi_co_action$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_action_flag_allows_v1(text, uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_action_flag_allows_v1(text, uuid) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_action_flag_allows_v1(text, uuid) FROM service_role;
  END IF;
END
$thu_hoi_co_action$;

-- Ảnh chụp registry tại thời điểm lập kế hoạch. Một chuỗi md5 duy nhất thay cho
-- việc chép cả bảng: nếu ai đó tắt một action, đổi version, hay thêm hàng mới
-- giữa lúc lập và lúc duyệt thì chuỗi này đổi, và `plan_digest` (vốn băm nó) đổi
-- theo — kế hoạch cũ không còn khớp với thế giới nó được sinh ra.
CREATE OR REPLACE FUNCTION app_private.copilot_plan_registry_revision_v1()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $rev$
  SELECT md5(COALESCE(string_agg(r.action_id || r.version::text, '' ORDER BY r.action_id), ''))
    FROM app_private.copilot_action_registry r;
$rev$;

COMMENT ON FUNCTION app_private.copilot_plan_registry_revision_v1() IS
  'md5 cua string_agg(action_id || version) theo action_id — anh chup registry di vao plan_digest.';

REVOKE ALL ON FUNCTION app_private.copilot_plan_registry_revision_v1() FROM PUBLIC;
DO $thu_hoi_rev$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_registry_revision_v1() FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_registry_revision_v1() FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_registry_revision_v1() FROM service_role;
  END IF;
END
$thu_hoi_rev$;

-- L5 TÀI CHÍNH — AI LÀ NGƯỜI NỘP, NGƯỜI THẬT LÀ NGƯỜI DUYỆT.
--
-- Đây là toàn bộ đường L5 của Mức 2, và nó cố tình KHÔNG duyệt gì cả: nó đẩy một
-- phiếu nháp của chính người đang thao tác vào hàng chờ duyệt, rồi ép hồ sơ phải
-- dừng ở `PENDING_APPROVAL`.
--
-- VÌ SAO `POSTED` LÀ LỖI, KHÔNG PHẢI THÀNH CÔNG
--   `submit_financial_voucher` chạy bộ luật duyệt của tổ chức. Nếu luật khớp
--   `AUTO_POST` thì nó tự hạch toán phiếu ngay trong lời gọi này — tức Copilot
--   vừa gián tiếp ghi sổ cái, đúng thứ mà cả kiến trúc L5 dựng ra để cấm. Không
--   có cách nào biết trước ngoài việc thử, nên đường duy nhất đúng là: thử, thấy
--   `POSTED` thì NÉM (`copilot_auto_post_forbidden`) và để khối con của
--   `execute_step` cuốn ngược sạch cả bút toán lẫn hồ sơ. `DENIED` (luật DENY)
--   không phải sự cố mà là câu trả lời của tổ chức, nhưng nó cũng phải cuốn
--   ngược: một hồ sơ DENIED nằm lại chỉ làm bẩn hàng chờ.
--
-- Chữ ký nhận thêm `p_plan_id`/`p_step_no` so với brief (brief viết hai tham số)
-- vì khoá chống-lặp mà chính brief yêu cầu — `copilot_plan:<plan>:<step>` — cần
-- đúng hai giá trị đó. Suy chúng từ đâu khác là bịa.
CREATE OR REPLACE FUNCTION app_private.copilot_plan_submit_voucher_v1(
  p_org      uuid,
  p_voucher  uuid,
  p_plan_id  uuid,
  p_step_no  int
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $nop_ho_so$
DECLARE
  v_actor uuid := auth.uid();
  v_ie    public.income_expenses%ROWTYPE;
  v_ket   jsonb;
  v_req   public.approval_requests%ROWTYPE;
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_org IS NULL OR p_voucher IS NULL OR p_plan_id IS NULL OR p_step_no IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  -- Khoá phiếu trước khi đo: giữa lúc đo và lúc nộp, một tab khác có thể đã nộp.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = p_voucher
     AND deleted_at IS NULL
   FOR UPDATE;
  -- Phiếu của công ty khác hoặc của người khác trả về ĐÚNG câu như phiếu không
  -- tồn tại: một mã lỗi riêng ở đây là một cách dò xem phiếu nào có thật.
  IF NOT FOUND
     OR v_ie.organization_id IS DISTINCT FROM p_org
     OR v_ie.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR v_ie.posting_status IS DISTINCT FROM 'UNPOSTED' THEN
    RAISE EXCEPTION 'voucher_not_draft' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.approval_requests a
     WHERE a.subject_type = 'FINANCIAL_VOUCHER'
       AND a.subject_id = p_voucher
       AND a.state IN ('PENDING_APPROVAL', 'POSTED')
  ) THEN
    RAISE EXCEPTION 'voucher_already_submitted' USING ERRCODE = '22023';
  END IF;

  -- `p_txn_type` để NULL: bộ luật tự suy loại nghiệp vụ từ chính phiếu. Truyền
  -- một giá trị đoán vào đây là lái luật duyệt sang nhánh khác.
  v_ket := public.submit_financial_voucher(
    p_voucher,
    'copilot_plan:' || p_plan_id::text || ':' || p_step_no::text,
    'AI_COPILOT',
    NULL
  );

  v_id := NULLIF(v_ket ->> 'request_id', '')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- ĐỌC LẠI TỪ BẢNG, không tin jsonb mà RPC gốc trả về.
  SELECT * INTO v_req FROM public.approval_requests a WHERE a.id = v_id;
  IF NOT FOUND
     OR v_req.organization_id IS DISTINCT FROM p_org
     OR v_req.maker_user_id IS DISTINCT FROM v_actor
     OR v_req.subject_id IS DISTINCT FROM p_voucher THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF v_req.state = 'POSTED' THEN
    RAISE EXCEPTION 'copilot_auto_post_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_req.state = 'DENIED' THEN
    RAISE EXCEPTION 'rule_denied' USING ERRCODE = '42501';
  END IF;
  IF v_req.state IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'approval_requests',
    'entity_id',    v_req.id,
    'rule_effect',  v_req.rule_effect,
    'idempotent',   COALESCE((v_ket ->> 'idempotent')::boolean, false)
  );
END
$nop_ho_so$;

COMMENT ON FUNCTION app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, int) IS
  'Nop mot phieu thu/chi nhap CUA CHINH nguoi dang thao tac vao engine duyet qua '
  'submit_financial_voucher (khoa chong-lap copilot_plan:<plan>:<step>, system_source AI_COPILOT). '
  'Ep ho so dung o PENDING_APPROVAL: POSTED do luat AUTO_POST nem copilot_auto_post_forbidden, '
  'DENY nem rule_denied — ca hai deu de khoi con cua execute_step cuon nguoc.';

REVOKE ALL ON FUNCTION app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, int) FROM PUBLIC;
DO $thu_hoi_nop$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, int) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, int) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, int) FROM service_role;
  END IF;
END
$thu_hoi_nop$;

-- MỘT CHỖ DUY NHẤT LƯỢC BỎ BÍ MẬT. Cả `create` (khi trả lại kế hoạch cũ) lẫn
-- `get` đều đi qua hàm này, nên không có đường nào để một trong hai quên lược bỏ
-- một trường. Thứ KHÔNG bao giờ ra khỏi đây: nonce (không lưu), `canonical`,
-- `payload`, và `payload_digest` thô. `plan_digest` ra dưới dạng hex vì giao diện
-- phải echo lại đúng chuỗi đó lúc bấm duyệt.
CREATE OR REPLACE FUNCTION app_private.copilot_plan_summary_v1(p_plan_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $tom_tat$
  SELECT jsonb_build_object(
    'plan_id',           p.id,
    'plan_version',      p.version,
    'plan_digest',       encode(p.plan_digest, 'hex'),
    'status',            p.status,
    'organization_id',   p.organization_id,
    'client_request_id', p.client_request_id,
    'max_risk',          p.max_risk,
    'step_count',        p.step_count,
    'consent_kind',      p.consent_kind,
    'registry_revision', p.registry_revision,
    'policy_revision',   p.policy_revision,
    'expires_at',        p.expires_at,
    'approved_at',       p.approved_at,
    'execute_deadline',  p.execute_deadline,
    'failure_reason',    p.failure_reason,
    'created_at',        p.created_at,
    'updated_at',        p.updated_at,
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'step_no',       s.step_no,
               'action_id',     s.action_id,
               'label_vi',      COALESCE(r.label_vi, s.action_id),
               'risk',          s.risk,
               'executor_kind', s.executor_kind,
               'status',        s.status,
               'preview',       s.preview,
               'outcome',       s.outcome,
               'error_code',    s.error_code,
               'ref_step',      s.ref_step,
               'executed_at',   s.executed_at
             ) ORDER BY s.step_no)
        FROM app_private.copilot_plan_steps s
        LEFT JOIN app_private.copilot_action_registry r ON r.action_id = s.action_id
       WHERE s.plan_id = p.id), '[]'::jsonb)
  )
    FROM app_private.copilot_plans p
   WHERE p.id = p_plan_id;
$tom_tat$;

COMMENT ON FUNCTION app_private.copilot_plan_summary_v1(uuid) IS
  'Ban doc DA LUOC BO cua mot ke hoach: khong nonce, khong canonical, khong payload, khong digest '
  'tho. Ca copilot_plan_create_v1 (tra lai ke hoach cu) lan copilot_plan_get_v1 deu di qua day.';

REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM PUBLIC;
DO $thu_hoi_tom_tat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_plan_summary_v1(uuid) FROM service_role;
  END IF;
END
$thu_hoi_tom_tat$;

-- ---------------------------------------------------------------------------
-- 3. RPC 1/6 — LẬP KẾ HOẠCH
-- ---------------------------------------------------------------------------
--
-- Thứ tự các cửa là một phần của thiết kế, không phải thói quen viết code:
--   danh tính → vai được phép lập kế hoạch → công tắc của cả cơ chế → hình dạng
--   đầu vào → chống lặp → hạn mức → rồi mới tới từng bước.
-- Mọi cửa rẻ và không rò thông tin đứng trước; lời gọi `preview_rpc` (đắt nhất,
-- và là thứ duy nhất chạm dữ liệu nghiệp vụ) đứng sau cùng.
CREATE OR REPLACE FUNCTION public.copilot_plan_create_v1(
  p_organization_id  uuid,
  p_client_request_id text,
  p_steps            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $lap_ke_hoach$
DECLARE
  v_actor      uuid := auth.uid();
  v_n          int;
  v_i          int;
  v_dem        int;
  v_cu         app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_reg_rev    text;
  v_buoc       jsonb;
  v_du_lieu    jsonb;
  v_hanh_dong  text;
  v_kq         jsonb;
  v_canonical  jsonb;
  v_preview    jsonb;
  v_nonce_hex  text;
  v_digest     bytea;
  v_ref        int;
  v_voucher    uuid;
  v_ie         public.income_expenses%ROWTYPE;
  v_gom        jsonb := '[]'::jsonb;
  v_gom_digest jsonb := '[]'::jsonb;
  v_max_risk   text := 'L3';
  v_plan_digest bytea;
  v_plan_id    uuid;
  v_het        timestamptz;
  v_nonce      bytea;
  v_consent_id uuid;
  v_message    text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  -- Vai được phép chạy kế hoạch đọc từ `copilot_action_policy.allowed_roles`
  -- (điểm nối #7). v1 seed `{superadmin}` nhưng KHÔNG hard-code ở đây: G4 mở vai
  -- khác bằng cách lật policy, không bằng cách sửa RPC này.
  IF NOT app_private.copilot_plan_role_allowed_v1(p_organization_id) THEN
    RAISE EXCEPTION 'plan_role_not_allowed' USING ERRCODE = '42501';
  END IF;

  -- Công tắc của CẢ cơ chế kế hoạch. Tắt = không lập được kế hoạch nào, kể cả
  -- khi từng action bên trong đang bật.
  IF NOT app_private.copilot_action_flag_allows_v1('copilot.execution_plan', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_client_request_id IS NULL
     OR p_client_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'client_request_id_invalid' USING ERRCODE = '22023';
  END IF;

  -- CHỐNG LẶP. Gửi lại cùng `client_request_id` trả về ĐÚNG kế hoạch cũ và
  -- `consent_nonce = null`: nonce chỉ ra một lần, và một lần gửi lại vì mạng chập
  -- không được biến thành một phiếu đồng ý thứ hai cho cùng dãy bước.
  SELECT * INTO v_cu
    FROM app_private.copilot_plans
   WHERE user_id = v_actor AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN app_private.copilot_plan_summary_v1(v_cu.id)
           || jsonb_build_object('consent_nonce', NULL, 'da_ton_tai', true);
  END IF;

  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'plan_steps_invalid' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_steps);
  IF v_n < 1 OR v_n > 8 THEN
    RAISE EXCEPTION 'plan_step_count: % buoc, cho phep 1..8', v_n USING ERRCODE = '22023';
  END IF;

  -- Hạn mức kế hoạch ĐANG MỞ. Đếm theo hạn thật của từng trạng thái chứ không
  -- theo status trần: trạng thái hết hạn được đánh giá LƯỜI (chỉ đổi khi có ai
  -- chạm vào kế hoạch), nên đếm trần sẽ khoá vĩnh viễn một người sau ba kế hoạch
  -- bỏ quên.
  SELECT count(*) INTO v_dem
    FROM app_private.copilot_plans p
   WHERE p.user_id = v_actor
     AND ((p.status = 'DRAFT' AND p.expires_at > clock_timestamp())
          OR (p.status = 'APPROVED'
              AND COALESCE(p.execute_deadline, p.expires_at) > clock_timestamp()));
  IF v_dem >= 3 THEN
    RAISE EXCEPTION 'plan_limit: dang co % ke hoach mo', v_dem USING ERRCODE = '22023';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  IF v_max_direct IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;
  v_reg_rev := app_private.copilot_plan_registry_revision_v1();

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_buoc := p_steps -> v_i;
    IF jsonb_typeof(COALESCE(v_buoc, 'null'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
    END IF;
    v_hanh_dong := v_buoc ->> 'hanh_dong';
    v_du_lieu := v_buoc -> 'du_lieu';
    IF v_hanh_dong IS NULL
       OR jsonb_typeof(COALESCE(v_du_lieu, 'null'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_hanh_dong;
    IF NOT FOUND OR NOT v_reg.enabled THEN
      RAISE EXCEPTION 'copilot_action_disabled: % (buoc %)', v_hanh_dong, v_i + 1
        USING ERRCODE = '42501';
    END IF;

    -- TRẦN RỦI RO. `maker_submit_v1` được miễn vì nó KHÔNG ghi trực tiếp: nó đẩy
    -- một phiếu nháp vào hàng chờ để một CON NGƯỜI khác duyệt. Đó là lý do một
    -- bước L5 kiểu đó chạy được trong khi trần đang là L4 — và cũng là lý do
    -- miễn trừ này chỉ áp cho đúng một `executor_kind`, không áp theo mức rủi ro.
    IF v_reg.executor_kind <> 'maker_submit_v1'
       AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
         > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
      RAISE EXCEPTION 'plan_risk_not_allowed: % la % nhung tran hien tai la %',
        v_hanh_dong, v_reg.risk, v_max_direct
        USING ERRCODE = '42501';
    END IF;

    -- CỔNG HÀNH ĐỘNG: registry + cờ kill switch + lệnh cấm khẩn cấp + phạm vi
    -- quyền thật. Hàm này tự NÉM với mã lỗi riêng của từng cửa.
    PERFORM app_private.copilot_action_gate_v1(v_hanh_dong, p_organization_id);

    IF v_reg.executor_kind = 'nonce_abi_v1' THEN
      -- Tên hàm ĐẾN TỪ REGISTRY (CHECK regex + hai CHECK theo hàng), không bao
      -- giờ từ client. Tham số đi vào bằng $1/$2, không bao giờ nối chuỗi.
      BEGIN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING p_organization_id, v_du_lieu;
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
        RAISE EXCEPTION 'step_preview_failed:%:%', v_i + 1, v_message USING ERRCODE = '22023';
      END;

      v_canonical := v_kq -> 'canonical';
      v_preview := v_kq -> 'preview';
      v_nonce_hex := v_kq ->> 'confirmation_nonce';
      IF jsonb_typeof(COALESCE(v_canonical, 'null'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'step_preview_failed:%:canonical_missing', v_i + 1
          USING ERRCODE = '22023';
      END IF;

      -- NONCE MỒ CÔI. Lời gọi xem trước vừa sinh ra một hàng xác nhận còn hạn 5
      -- phút cho một thao tác mà chưa ai đồng ý. Xoá NGAY, theo digest của chính
      -- nonce vừa nhận. Nonce thô chưa từng rời server nên hàng đó không dùng
      -- được nữa; để lại chỉ là 8 chiếc chìa khoá ghi tiền nằm chờ vô ích.
      IF v_nonce_hex ~ '^[0-9a-fA-F]{64}$' THEN
        DELETE FROM app_private.copilot_write_confirmations
         WHERE nonce_digest = extensions.digest(decode(v_nonce_hex, 'hex'), 'sha256');
      END IF;
      v_nonce_hex := NULL;

      v_digest := app_private.copilot_payload_hash_v1(v_canonical);
      v_ref := NULL;

    ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
      IF v_du_lieu ? '$ref_step' THEN
        BEGIN
          v_ref := (v_du_lieu ->> '$ref_step')::int;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'step_ref_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END;
        -- Chỉ tham chiếu NGƯỢC được: bước n phải nằm trước bước này, nếu không
        -- kế hoạch có thể tự vòng lại chính nó.
        IF v_ref IS NULL OR v_ref < 1 OR v_ref > v_i THEN
          RAISE EXCEPTION 'step_ref_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        -- Bước được trỏ tới phải SINH RA đúng loại thực thể mà bước này TIÊU THỤ.
        IF (v_gom -> (v_ref - 1) ->> 'produces_entity_table')
             IS DISTINCT FROM v_reg.consumes_ref_table THEN
          RAISE EXCEPTION 'step_ref_incompatible:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        v_canonical := jsonb_build_object('$ref_step', v_ref);
        v_preview := jsonb_build_object(
          'loai',       'nop_ho_so',
          'nguon',      'ket qua cua buoc ' || v_ref::text,
          'trang_thai', 'Se nop vao hang cho duyet — AI KHONG duyet');
      ELSIF v_du_lieu ? 'voucher_id' THEN
        BEGIN
          v_voucher := (v_du_lieu ->> 'voucher_id')::uuid;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END;
        SELECT * INTO v_ie
          FROM public.income_expenses ie
         WHERE ie.id = v_voucher
           AND ie.deleted_at IS NULL
           AND ie.organization_id = p_organization_id
           AND ie.user_id = v_actor
           AND ie.approval_status = 'UNAPPROVED'
           AND ie.posting_status = 'UNPOSTED';
        -- Hai điều kiện tách làm hai câu lệnh có chủ ý: `FOUND` là biến ngầm của
        -- lệnh TRƯỚC đó, và gộp nó vào cùng một biểu thức với một truy vấn con
        -- là đúng kiểu viết mà người đọc sau phải dừng lại đoán.
        IF NOT FOUND THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
          SELECT 1 FROM public.approval_requests a
           WHERE a.subject_type = 'FINANCIAL_VOUCHER'
             AND a.subject_id = v_voucher
             AND a.state IN ('PENDING_APPROVAL', 'POSTED')
        ) THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        v_canonical := jsonb_build_object('voucher_id', v_voucher);
        v_preview := jsonb_build_object(
          'loai',       'nop_ho_so',
          'phieu',      v_ie.name,
          'so_tien',    v_ie.total_amount,
          'trang_thai', 'Se nop vao hang cho duyet — AI KHONG duyet');
        v_ref := NULL;
      ELSE
        RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
      END IF;
      v_digest := app_private.copilot_payload_hash_v1(v_canonical);

    ELSE
      -- `direct_l5_v1` là của Mức 3 (G5-C). Nói thẳng là chưa có, thay vì để nó
      -- rơi vào một nhánh mặc định nào đó.
      RAISE EXCEPTION 'executor_not_supported: %', v_reg.executor_kind USING ERRCODE = '0A000';
    END IF;

    IF (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
       > (CASE v_max_risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
      v_max_risk := v_reg.risk;
    END IF;

    v_gom := v_gom || jsonb_build_array(jsonb_build_object(
      'step_no',               v_i + 1,
      'action_id',             v_reg.action_id,
      'action_version',        v_reg.version,
      'label_vi',              v_reg.label_vi,
      'permission_key',        v_reg.permission_key,
      'risk',                  v_reg.risk,
      'executor_kind',         v_reg.executor_kind,
      'produces_entity_table', v_reg.produces_entity_table,
      'payload',               v_du_lieu,
      'canonical',             v_canonical,
      'payload_digest',        encode(v_digest, 'hex'),
      'preview',               v_preview,
      'ref_step',              v_ref));

    -- Đầu vào của `plan_digest`: đúng bốn trường theo brief, theo thứ tự bước.
    -- Mảng được nối theo vòng lặp nên nó ĐÃ sắp theo step_no; không cần ORDER BY.
    v_gom_digest := v_gom_digest || jsonb_build_array(jsonb_build_object(
      'n', v_i + 1,
      'a', v_reg.action_id,
      'v', v_reg.version,
      'd', encode(v_digest, 'hex')));
  END LOOP;

  v_plan_digest := app_private.copilot_payload_hash_v1(jsonb_build_object(
    'organization_id',   p_organization_id,
    'actor',             v_actor,
    'registry_revision', v_reg_rev,
    'steps',             v_gom_digest));

  v_het := clock_timestamp() + interval '5 minutes';

  BEGIN
    INSERT INTO app_private.copilot_plans (
      user_id, organization_id, client_request_id, status, version, plan_digest,
      registry_revision, policy_revision, max_risk, step_count, expires_at
    )
    VALUES (
      v_actor, p_organization_id, p_client_request_id, 'DRAFT', 1, v_plan_digest,
      v_reg_rev, v_policy_rev, v_max_risk, v_n, v_het
    )
    RETURNING id INTO v_plan_id;
  EXCEPTION WHEN unique_violation THEN
    -- Hai lời gọi song song cùng `client_request_id`. Kẻ thua trả về kế hoạch của
    -- kẻ thắng, không nonce — đúng như đường chống lặp ở trên.
    SELECT * INTO v_cu
      FROM app_private.copilot_plans
     WHERE user_id = v_actor AND client_request_id = p_client_request_id;
    RETURN app_private.copilot_plan_summary_v1(v_cu.id)
           || jsonb_build_object('consent_nonce', NULL, 'da_ton_tai', true);
  END;

  INSERT INTO app_private.copilot_plan_steps (
    plan_id, step_no, action_id, action_version, permission_key, risk, executor_kind,
    payload, canonical, payload_digest, preview, ref_step, status
  )
  SELECT
    v_plan_id,
    (e ->> 'step_no')::int,
    e ->> 'action_id',
    (e ->> 'action_version')::int,
    e ->> 'permission_key',
    e ->> 'risk',
    e ->> 'executor_kind',
    e -> 'payload',
    e -> 'canonical',
    decode(e ->> 'payload_digest', 'hex'),
    e -> 'preview',
    NULLIF(e ->> 'ref_step', '')::int,
    'PENDING'
    FROM jsonb_array_elements(v_gom) e;

  -- ĐỒNG Ý CẤP KẾ HOẠCH: một hàng trong đúng cái kho nonce mà mọi thao tác ghi
  -- của Copilot đã dùng, chỉ khác `tool`. `copilot_execute_income_expense_v1`
  -- kiểm `tool` nên nonce kế hoạch không bao giờ tiêu được cho một phiếu lẻ, và
  -- ngược lại.
  v_nonce := extensions.gen_random_bytes(32);
  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash, permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'lap_ke_hoach', v_plan_digest, 'copilot.execution_plan', v_het)
  RETURNING id INTO v_consent_id;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_created',
    'organization_id', p_organization_id,
    'plan_id',         v_plan_id,
    'plan_version',    1,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_reg_rev,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_max_risk,
      'step_count',        v_n,
      'flag_plan',         true,
      'checked_at',        clock_timestamp()),
    'consent_id',      v_consent_id,
    'payload_digest',  encode(v_plan_digest, 'hex'),
    'outcome', jsonb_build_object(
      'status',            'DRAFT',
      'client_request_id', p_client_request_id,
      'actions',           (SELECT jsonb_agg(e ->> 'action_id') FROM jsonb_array_elements(v_gom) e))
  ));

  RETURN app_private.copilot_plan_summary_v1(v_plan_id)
         || jsonb_build_object(
              -- Nonce thô ra ĐÚNG MỘT LẦN. Client giữ trong bộ nhớ; nó không vào
              -- ngữ cảnh mô hình, không vào lịch sử chat, không vào URL, không log.
              'consent_nonce', encode(v_nonce, 'hex'),
              'da_ton_tai',    false);
END
$lap_ke_hoach$;

COMMENT ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) IS
  'Lap ke hoach thuc thi 1..8 buoc: kiem vai + cong tac ke hoach + tran rui ro + cong hanh dong '
  'tung buoc, goi preview_rpc (ten tu registry) de chot canonical va XOA nonce mo coi ngay, roi '
  'phat MOT nonce cap ke hoach. Tra ve nonce dung mot lan; goi lai cung client_request_id tra ke '
  'hoach cu voi consent_nonce = null.';

REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM PUBLIC;
DO $quyen_lap$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) TO authenticated;
  END IF;
END
$quyen_lap$;

-- ---------------------------------------------------------------------------
-- 4. RPC 2/6 — DUYỆT KẾ HOẠCH
-- ---------------------------------------------------------------------------
--
-- Hàm này là CHỖ DUY NHẤT biến "một dãy bước đã xem trước" thành "được phép
-- chạy". Nó không nằm trong bất kỳ tool nào của mô hình — chỉ giao diện gọi nó,
-- và nó đòi ba thứ mà mô hình không thể tự dựng:
--   · `p_consent_nonce`  — 32 byte server phát, chỉ trả một lần, không vào ngữ cảnh
--   · `p_plan_digest`    — vân tay kế hoạch mà giao diện ECHO lại từ màn hình
--   · `p_expected_plan_version` — CAS, chặn hai tab duyệt hai lần
--
-- `p_step_up_token` (điểm nối #3) đã có trong chữ ký TỪ HÔM NAY và mặc định NULL.
-- Thân verify PIN là việc của G5-A; ở v1 nó chỉ có hai câu trả lời trung thực:
-- thiếu token cho kế hoạch L5 khi trần đã mở L5 → `step_up_required`; có token →
-- `step_up_not_implemented` (0A000). Nhận rồi lặng lẽ bỏ qua một token mới là
-- điều nguy hiểm: giao diện sẽ tin rằng đã có bước xác thực thứ hai.
CREATE OR REPLACE FUNCTION public.copilot_plan_approve_v1(
  p_plan_id               uuid,
  p_consent_nonce         text,
  p_plan_digest           text,
  p_expected_plan_version int,
  p_step_up_token         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $duyet_ke_hoach$
DECLARE
  v_actor      uuid := auth.uid();
  v_conf       app_private.copilot_write_confirmations%ROWTYPE;
  v_plan       app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_step       app_private.copilot_plan_steps%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_ly_do      text := NULL;
  v_chi_tiet   text := NULL;
  v_buoc_hong  int := NULL;
  v_version    int;
  v_han        timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Hình sai thì không cần chạm bảng nonce: một lời gọi không có nonce thật
  -- không được phép soi cả bảng đó.
  IF p_consent_nonce IS NULL OR p_consent_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;
  IF p_plan_digest IS NULL OR p_plan_digest !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Khoá hàng nonce ngay từ đầu: hai lần bấm song song phải có đúng một lần thắng.
  SELECT * INTO v_conf
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_consent_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  -- Nonce của người khác trả về cùng một câu với "không tìm thấy" — trả lời khác
  -- đi là xác nhận giúp kẻ gọi rằng nonce đó có thật.
  IF v_conf.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_conf.tool IS DISTINCT FROM 'lap_ke_hoach'
     OR v_conf.permission_key IS DISTINCT FROM 'copilot.execution_plan' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_conf.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_conf.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- Hai tab. Không chờ: một trong hai đang ở giữa một chuỗi ghi tiền.
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.organization_id IS DISTINCT FROM v_conf.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  -- Ba vế phải trùng nhau: vân tay lưu trong kế hoạch, `payload_hash` của hàng
  -- nonce, và chuỗi giao diện echo lại. Lệch một vế nghĩa là thứ người dùng nhìn
  -- thấy không phải thứ sắp chạy.
  IF v_plan.plan_digest IS DISTINCT FROM decode(p_plan_digest, 'hex')
     OR v_conf.payload_hash IS DISTINCT FROM v_plan.plan_digest THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_plan.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'plan_not_draft: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- QUÁ HẠN. Ghi trạng thái rồi TRẢ VỀ, không RAISE — xem quyết định 4 ở đầu file.
  IF v_plan.expires_at <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'approve')));
    RETURN jsonb_build_object(
      'plan_id', v_plan.id, 'plan_version', v_version, 'status', 'EXPIRED',
      'execute_deadline', NULL, 'error_code', 'plan_expired');
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;

  -- ĐIỂM NỐI #3 — step-up PIN. Ở v1 (`max_direct_risk = 'L4'`) một kế hoạch L5
  -- chỉ có thể là L5 nhờ `maker_submit_v1`, vốn được miễn trần, nên nhánh này
  -- chưa chạy trong thực tế; nó tồn tại để G5-A chỉ phải thay THÂN, không phải
  -- thay chữ ký và không phải đụng giao diện.
  IF v_plan.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;
  IF p_step_up_token IS NOT NULL THEN
    RAISE EXCEPTION 'step_up_not_implemented' USING ERRCODE = '0A000';
  END IF;

  -- Công tắc của cả cơ chế, hỏi LẠI. Tắt giữa lúc lập và lúc bấm là chuyện thật
  -- (đó chính là ý nghĩa của một kill switch), và ở đây chưa có gì để ghi lại
  -- nên NÉM là câu trả lời đúng: kế hoạch ở nguyên DRAFT rồi tự hết hạn.
  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- KIỂM LẠI TOÀN BỘ BƯỚC NGAY TRƯỚC KHI DUYỆT. Giữa lúc lập và lúc bấm có tới 5
  -- phút: đủ để ai đó thu quyền, tắt một action, hoặc kéo cầu dao khẩn cấp.
  FOR v_step IN
    SELECT * FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id ORDER BY step_no
  LOOP
    BEGIN
      SELECT * INTO v_reg
        FROM app_private.copilot_action_registry
       WHERE action_id = v_step.action_id;
      IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
        v_ly_do := 'registry_changed';
      ELSE
        PERFORM app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);
      END IF;
    EXCEPTION WHEN others THEN
      -- Giữ nguyên mã lỗi THẬT của cửa đã chặn (`copilot_action_disabled`,
      -- `tenant_emergency_denied`, `not_permitted`…). Ép tất cả về một chữ
      -- `step_not_permitted` sẽ làm người trực sự cố đi sửa phân quyền cho một
      -- lệnh cấm khẩn cấp — cùng lớp lỗi mà thứ tự bốn cửa của G2-A đã sửa.
      GET STACKED DIAGNOSTICS v_chi_tiet = MESSAGE_TEXT;
      v_ly_do := COALESCE(NULLIF(split_part(v_chi_tiet, ':', 1), ''), 'step_not_permitted');
    END;
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
  END LOOP;

  IF v_ly_do IS NOT NULL THEN
    -- NONCE VẪN BỊ TIÊU. Người dùng đã bấm; phiếu đồng ý đó đã được dùng, và
    -- việc kế hoạch không chạy được là câu trả lời chứ không phải một lần bấm
    -- hỏng. Để nonce sống tiếp là mở đường thử lại tới khi lọt.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_conf.id AND consumed_at IS NULL;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED',
           error_code = CASE WHEN step_no = v_buoc_hong THEN v_ly_do ELSE 'plan_failed' END
     WHERE plan_id = v_plan.id AND status = 'PENDING';

    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           consent_confirmation_id = v_conf.id,
           consent_kind = 'click',
           failure_reason = 'step_not_permitted:' || v_buoc_hong::text || ':' || v_ly_do,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_blocked',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         v_buoc_hong,
      'plan_version',    v_version,
      'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                           WHERE plan_id = v_plan.id AND step_no = v_buoc_hong),
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_conf.id,
      'consent_kind',    'click',
      'error_code',      v_ly_do,
      'outcome',         jsonb_build_object('giai_doan', 'approve', 'plan_status', 'FAILED')));

    RETURN jsonb_build_object(
      'plan_id', v_plan.id, 'plan_version', v_version, 'status', 'FAILED',
      'execute_deadline', NULL, 'error_code', v_ly_do, 'step_no', v_buoc_hong);
  END IF;

  -- CAS TIÊU NONCE. `consumed_at IS NULL` trong WHERE là thứ biến hai lần bấm
  -- song song thành một lần duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_conf.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  v_han := clock_timestamp() + interval '30 minutes';
  UPDATE app_private.copilot_plans
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         execute_deadline = v_han,
         consent_confirmation_id = v_conf.id,
         consent_kind = 'click',
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_approved',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_plan.registry_revision,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_plan.max_risk,
      'step_count',        v_plan.step_count,
      'is_super_admin',    public.is_super_admin(),
      'checked_at',        clock_timestamp()),
    'consent_id',      v_conf.id,
    'consent_kind',    'click',
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object('status', 'APPROVED', 'execute_deadline', v_han)));

  RETURN jsonb_build_object(
    'plan_id',          v_plan.id,
    'plan_version',     v_version,
    'status',           'APPROVED',
    'execute_deadline', v_han);
END
$duyet_ke_hoach$;

COMMENT ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, int, text) IS
  'Duyet ke hoach: tieu nonce cap ke hoach (CAS consumed_at), doi chieu plan_digest ba ve, CAS '
  'version, kiem lai TOAN BO buoc ngay truoc khi mo cong, roi dat han thuc thi 30 phut. Chi giao '
  'dien goi ham nay — khong tool nao cua mo hinh duoc phep goi.';

REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, int, text) FROM PUBLIC;
DO $quyen_duyet$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, int, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, int, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, int, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, int, text) TO authenticated;
  END IF;
END
$quyen_duyet$;

-- ---------------------------------------------------------------------------
-- 5. RPC 3/6 — THỰC THI MỘT BƯỚC
-- ---------------------------------------------------------------------------
--
-- MỘT LỜI GỌI = MỘT BƯỚC = MỘT GIAO DỊCH. Không có vòng lặp nào ở đây: client
-- gọi lại cho bước kế tiếp. Lý do là thứ đã trả giá ở đường thu/chi — writer
-- ràng vào `pg_current_xact_id()` và một advisory lock theo giao dịch, nên gộp
-- nhiều bước vào một giao dịch sẽ làm hai bước dùng chung một khoá chống-lặp.
--
-- BA TẦNG, THEO ĐÚNG THỨ TỰ NÀY:
--   (1) danh tính + kế hoạch (khoá NOWAIT, tổ chức, trạng thái, hạn, phiên bản,
--       bước đúng thứ tự) — mọi thứ ở đây NÉM, vì chưa có gì để ghi lại.
--   (2) TIỀN KIỂM ngay trước khi ghi: công tắc kế hoạch, cổng hành động, registry
--       còn khớp ảnh chụp, digest lưu còn khớp `canonical`. Hỏng ở tầng này =
--       `step_blocked`: chưa đụng vào dữ liệu nào.
--   (3) KHỐI CON thực thi: xem trước LẠI → so digest → `execute_rpc` → đọc lại.
--       Hỏng ở tầng này = `step_failed`, và khối con cuốn ngược sạch hiệu ứng.
--
-- Tầng (2) và (3) đều KHÔNG ném ra ngoài: chúng ghi mã lỗi vào biến, rồi phần
-- đuôi (ở giao dịch ngoài) cập nhật trạng thái và ghi sổ. Đó là toàn bộ lý do
-- một bước hỏng vẫn để lại bằng chứng.
CREATE OR REPLACE FUNCTION public.copilot_plan_execute_step_v1(
  p_plan_id               uuid,
  p_step_no               int,
  p_expected_plan_version int,
  p_organization_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_buoc$
DECLARE
  v_actor       uuid := auth.uid();
  v_plan        app_private.copilot_plans%ROWTYPE;
  v_step        app_private.copilot_plan_steps%ROWTYPE;
  v_reg         app_private.copilot_action_registry%ROWTYPE;
  v_snapshot    jsonb := '{}'::jsonb;
  v_next        int;
  v_version     int;
  v_kq          jsonb;
  v_ket         jsonb;
  v_canon_moi   jsonb;
  v_nonce       text;
  v_bang        text;
  v_entity_id   uuid;
  v_audit_id    uuid;
  v_trang_thai  text;
  v_after       jsonb;
  v_after_hex   text;
  v_voucher     uuid;
  v_idem        boolean := false;
  v_loi         text := NULL;
  v_chi_tiet    text := NULL;
  v_sqlstate    text := NULL;
  v_su_kien     text := NULL;
  v_ledger_id   uuid;
  v_plan_status text;
  v_buoc_status text;
  v_chan        int[];
  v_j           int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Tổ chức đi vào như một tham số RIÊNG và phải khớp kế hoạch. Đây là hàng rào
  -- chống "đổi công ty giữa phiên": client bind org của phiên vào lời gọi, nên
  -- một kế hoạch của công ty A không chạy được từ màn hình công ty B.
  IF p_organization_id IS NULL OR v_plan.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;

  -- QUÁ HẠN THỰC THI. Ghi rồi TRẢ VỀ (quyết định 4 ở đầu file): mọi bước còn chờ
  -- thành BLOCKED và kế hoạch thành EXPIRED, nếu không nó nằm mãi ở APPROVED và
  -- hạn mức "3 kế hoạch mở" sẽ đếm nhầm.
  IF COALESCE(v_plan.execute_deadline, v_plan.expires_at) <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'execute')));
    RETURN jsonb_build_object(
      'plan_id',      v_plan.id,
      'plan_version', v_version,
      'plan_status',  'EXPIRED',
      'step', jsonb_build_object(
        'step_no', p_step_no, 'status', 'BLOCKED', 'outcome', NULL,
        'error_code', 'plan_expired'),
      'next_step_no', NULL,
      'error_code',   'plan_expired');
  END IF;

  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- BƯỚC TUYẾN TÍNH. Chỉ bước PENDING nhỏ nhất được chạy, và mọi bước trước nó
  -- phải DONE. Không có đường nhảy cóc: bước 3 thường phụ thuộc kết quả bước 1.
  SELECT min(step_no) INTO v_next
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'plan_no_pending_step' USING ERRCODE = '22023';
  END IF;
  IF p_step_no IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'step_order: buoc ke tiep la %', v_next USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND step_no < p_step_no AND status <> 'DONE'
  ) THEN
    RAISE EXCEPTION 'step_order: con buoc truoc chua xong' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ---------------------------------------------------------------------
  -- TẦNG (2) — TIỀN KIỂM, ngay trước khi ghi. Không phải kiểm lại cho vui:
  -- giữa lúc duyệt và lúc bấm chạy có tới 30 phút.
  -- ---------------------------------------------------------------------
  BEGIN
    IF NOT app_private.copilot_action_flag_allows_v1(
             'copilot.execution_plan', v_plan.organization_id) THEN
      RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_step.action_id;
    IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
      RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
    END IF;

    v_snapshot := app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);

    -- Digest đã duyệt phải còn khớp `canonical` đang lưu. Vế này bắt đúng một
    -- kiểu tấn công: sửa thẳng hàng bước trong database giữa duyệt và chạy.
    IF v_step.canonical IS NULL
       OR v_step.payload_digest IS NULL
       OR app_private.copilot_payload_hash_v1(v_step.canonical)
            IS DISTINCT FROM v_step.payload_digest THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
    v_loi := split_part(v_chi_tiet, ':', 1);
    v_su_kien := 'step_blocked';
  END;

  -- ---------------------------------------------------------------------
  -- TẦNG (3) — KHỐI CON THỰC THI. Mọi hiệu ứng ghi nằm trong đây và chỉ
  -- trong đây, nên một lỗi bất kỳ cuốn ngược sạch mà giao dịch ngoài vẫn
  -- sống để ghi sổ.
  -- ---------------------------------------------------------------------
  IF v_loi IS NULL THEN
    BEGIN
      IF v_reg.executor_kind = 'nonce_abi_v1' THEN
        -- XEM TRƯỚC LẠI để lấy nonce MỚI. Nonce này sinh ra và bị tiêu trong
        -- đúng giao dịch này; nó không tồn tại ở đâu khác, không ai cầm được.
        -- Tên hàm đến từ REGISTRY (CHECK regex + hai CHECK theo hàng).
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        -- Thế giới đã đổi (giá, hạng mục, tên toà…) thì `canonical` mới sẽ băm
        -- ra khác. Dừng lại: thứ sắp ghi không còn là thứ người dùng đã duyệt.
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;

      ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
        IF v_step.ref_step IS NOT NULL THEN
          -- `{$ref_step: n}`: thực thể do bước n vừa tạo. Đọc từ KẾT QUẢ ĐÃ GHI
          -- của bước đó, không từ payload — payload không biết id sẽ là gì.
          SELECT NULLIF(s.outcome ->> 'entity_id', '')::uuid INTO v_voucher
            FROM app_private.copilot_plan_steps s
           WHERE s.plan_id = v_plan.id
             AND s.step_no = v_step.ref_step
             AND s.status = 'DONE';
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'ref_step_unresolved' USING ERRCODE = '22023';
          END IF;
        ELSE
          v_voucher := NULLIF(v_step.canonical ->> 'voucher_id', '')::uuid;
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'step_voucher_invalid' USING ERRCODE = '22023';
          END IF;
        END IF;
        v_ket := app_private.copilot_plan_submit_voucher_v1(
                   v_plan.organization_id, v_voucher, v_plan.id, v_step.step_no);

      ELSE
        RAISE EXCEPTION 'executor_not_supported' USING ERRCODE = '0A000';
      END IF;

      v_trang_thai := COALESCE(v_ket ->> 'status', 'da_thuc_hien');
      v_bang := COALESCE(NULLIF(v_ket ->> 'entity_table', ''), v_reg.produces_entity_table);
      v_entity_id := NULLIF(v_ket ->> 'entity_id', '')::uuid;
      v_audit_id := NULLIF(v_ket ->> 'audit_id', '')::uuid;
      -- Chạy lại một bước đã ghi KHÔNG phải lỗi: lớp chống-lặp của chính action
      -- trả về bản ghi cũ. Bước vẫn DONE, chỉ mang cờ `idempotent`.
      v_idem := v_trang_thai IN ('da_thuc_hien_truoc_do', 'da_tao_truoc_do')
                OR COALESCE((v_ket ->> 'idempotent')::boolean, false);

      -- ĐỌC LẠI TỪ BẢNG. Tên bảng đến từ kết quả của RPC đã chạy hoặc từ
      -- registry — KHÔNG từ tham số của người gọi — và vẫn đi qua `%I` cộng một
      -- ràng buộc hình dạng, nên trường hợp xấu nhất là một định danh không tồn
      -- tại (bước FAILED), không phải một câu lệnh chắp nối.
      IF v_entity_id IS NULL OR v_bang IS NULL OR v_bang !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_bang)
         INTO v_after
        USING v_entity_id;
      IF v_after IS NULL
         OR NULLIF(v_after ->> 'organization_id', '')::uuid
              IS DISTINCT FROM v_plan.organization_id THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;

      -- Bất biến theo `verify_kind` của registry. Sai ở đây nghĩa là hàng ghi ra
      -- KHÔNG đúng thứ thẻ xem trước đã hứa — cuốn ngược, đừng chữa.
      CASE v_reg.verify_kind
        WHEN 'ie_draft' THEN
          IF v_after ->> 'approval_status' IS DISTINCT FROM 'UNAPPROVED'
             OR v_after ->> 'posting_status' IS DISTINCT FROM 'UNPOSTED'
             OR NULLIF(v_after ->> 'user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'approval_request_pending' THEN
          IF v_after ->> 'state' IS DISTINCT FROM 'PENDING_APPROVAL'
             OR NULLIF(v_after ->> 'maker_user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'hold_pending_approval' THEN
          IF v_after ->> 'status' IS DISTINCT FROM 'PENDING_APPROVAL' THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        ELSE
          -- 'readback': tồn tại + đúng tổ chức đã là toàn bộ lời hứa.
          NULL;
      END CASE;
    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
      v_loi := split_part(v_chi_tiet, ':', 1);
      v_su_kien := 'step_failed';
    END;
  END IF;

  -- ---------------------------------------------------------------------
  -- ĐUÔI — chạy ở GIAO DỊCH NGOÀI. Đây là chỗ trạng thái và sổ được ghi, và
  -- đó là lý do chúng sống sót qua lần cuộn ngược của khối con.
  -- ---------------------------------------------------------------------
  IF v_loi IS NULL THEN
    v_after_hex := encode(
      extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex');

    UPDATE app_private.copilot_plan_steps
       SET status = 'DONE',
           outcome = jsonb_build_object(
             'entity_table', v_bang,
             'entity_id',    v_entity_id,
             'audit_id',     v_audit_id,
             'idempotent',   v_idem,
             'status',       v_trang_thai),
           error_code = NULL,
           error_detail = NULL,
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'step_done',
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_plan.version + 1,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'after_digest',        v_after_hex,
      'entity_table',        v_bang,
      'entity_id',           v_entity_id,
      'audit_id',            v_audit_id,
      'outcome', jsonb_build_object('status', v_trang_thai, 'idempotent', v_idem)));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    v_buoc_status := 'DONE';
    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    v_plan_status := CASE WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

  ELSE
    v_buoc_status := CASE WHEN v_su_kien = 'step_blocked' THEN 'BLOCKED' ELSE 'FAILED' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           error_code = v_loi,
           error_detail = left(COALESCE(v_chi_tiet, ''), 1000),
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- Một bước hỏng làm CẢ kế hoạch dừng. Không có "bỏ qua rồi chạy tiếp": bước
    -- sau thường tựa vào kết quả bước trước, và đoán xem cái nào độc lập là đúng
    -- kiểu suy luận mà một hệ ghi tiền không được phép làm.
    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           failure_reason = v_su_kien || ':' || p_step_no::text || ':' || COALESCE(v_loi, '?'),
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               v_su_kien,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_version,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'error_code',          v_loi,
      'sqlstate',            v_sqlstate,
      'outcome', jsonb_build_object(
        'plan_status', 'FAILED',
        'chi_tiet',    left(COALESCE(v_chi_tiet, ''), 200))));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- Mỗi bước bị chặn theo có một dòng sổ riêng. Gộp lại thành một dòng sẽ làm
    -- việc dựng lại "bước nào đã không chạy" thành suy đoán.
    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'consent_id',      v_plan.consent_confirmation_id,
          'consent_kind',    v_plan.consent_kind,
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'plan_status',  v_plan_status,
    'step', jsonb_build_object(
      'step_no',    p_step_no,
      'status',     v_buoc_status,
      'outcome',    CASE WHEN v_loi IS NULL THEN jsonb_build_object(
                           'entity_table', v_bang,
                           'entity_id',    v_entity_id,
                           'audit_id',     v_audit_id,
                           'idempotent',   v_idem)
                         ELSE NULL END,
      'error_code', v_loi),
    'next_step_no', v_next);
END
$thuc_thi_buoc$;

COMMENT ON FUNCTION public.copilot_plan_execute_step_v1(uuid, int, int, uuid) IS
  'Chay dung MOT buoc cua ke hoach da duyet: khoa ke hoach NOWAIT, ep tuyen tinh, tien kiem cong '
  'tac + cong hanh dong + registry + digest, roi xem truoc LAI de lay nonce moi va goi execute_rpc '
  '(ten tu registry) trong mot khoi con. Buoc hong cuon nguoc hieu ung nhung so va trang thai van '
  'duoc ghi o giao dich ngoai.';

REVOKE ALL ON FUNCTION public.copilot_plan_execute_step_v1(uuid, int, int, uuid) FROM PUBLIC;
DO $quyen_thuc_thi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_execute_step_v1(uuid, int, int, uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_execute_step_v1(uuid, int, int, uuid) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_execute_step_v1(uuid, int, int, uuid) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_execute_step_v1(uuid, int, int, uuid) TO authenticated;
  END IF;
END
$quyen_thuc_thi$;

-- ---------------------------------------------------------------------------
-- 6. RPC 4/6 — ĐỌC KẾ HOẠCH
-- ---------------------------------------------------------------------------
--
-- Đây là câu trả lời cho câu hỏi "client mất kết nối giữa chừng thì sao": KHÔNG
-- ĐOÁN. Gọi hàm này và đọc trạng thái thật. Nó STABLE, không khoá dòng nào
-- (một hàm STABLE mà `FOR UPDATE` sẽ chết 25006 ngay lần gọi đầu), và nó không
-- trả ra nonce, `canonical`, `payload` hay digest thô của bước — mọi thứ đó bị
-- chặn ở `copilot_plan_summary_v1`.
CREATE OR REPLACE FUNCTION public.copilot_plan_get_v1(p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $doc_ke_hoach$
DECLARE
  v_actor uuid := auth.uid();
  v_plan  app_private.copilot_plans%ROWTYPE;
  v_so    jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_plan FROM app_private.copilot_plans WHERE id = p_plan_id;
  -- Kế hoạch của người khác trả về ĐÚNG câu như kế hoạch không tồn tại.
  IF NOT FOUND
     OR (v_plan.user_id IS DISTINCT FROM v_actor AND NOT public.is_super_admin()) THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 20 dòng sổ gần nhất, đã bỏ ba cột digest. Chúng là bằng chứng nội bộ để đối
  -- chiếu payload; một chuỗi hex 64 ký tự trong tay trình duyệt chỉ mời người ta
  -- thử đoán ngược.
  SELECT COALESCE(jsonb_agg(
           to_jsonb(t) - 'payload_digest' - 'before_digest' - 'after_digest'), '[]'::jsonb)
    INTO v_so
    FROM (
      SELECT l.*
        FROM app_private.copilot_action_ledger l
       WHERE l.plan_id = p_plan_id
       ORDER BY l.created_at DESC
       LIMIT 20
    ) t;

  RETURN app_private.copilot_plan_summary_v1(p_plan_id)
         || jsonb_build_object('ledger', v_so);
END
$doc_ke_hoach$;

COMMENT ON FUNCTION public.copilot_plan_get_v1(uuid) IS
  'Doc trang thai that cua mot ke hoach (chu ke hoach hoac super admin) kem 20 dong so gan nhat. '
  'Khong tra nonce, canonical, payload hay digest tho. Client mat ket noi thi goi ham nay, khong doan.';

REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM PUBLIC;
DO $quyen_doc$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_get_v1(uuid) TO authenticated;
  END IF;
END
$quyen_doc$;

-- ---------------------------------------------------------------------------
-- 7. RPC 5/6 — HUỶ KẾ HOẠCH
-- ---------------------------------------------------------------------------
--
-- Huỷ KHÔNG lùi lại thứ đã ghi. Bước đã DONE giữ nguyên hiệu ứng của nó; đường
-- lùi là `registry.rollback_rpc` hoặc `rollback_note` (thao tác người dùng trên
-- giao diện). Cái mà huỷ làm là đóng cửa: bước còn chờ thành SKIPPED, phiếu đồng
-- ý bị tiêu, và kế hoạch không chạy tiếp được nữa.
CREATE OR REPLACE FUNCTION public.copilot_plan_cancel_v1(
  p_plan_id               uuid,
  p_expected_plan_version int,
  p_reason                text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $huy_ke_hoach$
DECLARE
  v_actor   uuid := auth.uid();
  v_plan    app_private.copilot_plans%ROWTYPE;
  v_version int;
  v_bo_qua  int;
  v_ly_do   text := left(COALESCE(btrim(p_reason), ''), 500);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.status NOT IN ('DRAFT', 'APPROVED') THEN
    RAISE EXCEPTION 'plan_not_cancellable: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- Tiêu phiếu đồng ý nếu nó còn sống. Với kế hoạch DRAFT thì
  -- `consent_confirmation_id` còn NULL (nó chỉ được điền lúc duyệt), nên tìm
  -- theo `payload_hash` — vốn CHÍNH LÀ `plan_digest`, và đó là quan hệ duy nhất
  -- giữa hàng nonce và kế hoạch trước khi duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE user_id = v_actor
     AND tool = 'lap_ke_hoach'
     AND payload_hash = v_plan.plan_digest
     AND consumed_at IS NULL;

  UPDATE app_private.copilot_plan_steps
     SET status = 'SKIPPED', error_code = 'plan_cancelled'
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  GET DIAGNOSTICS v_bo_qua = ROW_COUNT;

  UPDATE app_private.copilot_plans
     SET status = 'CANCELLED',
         version = version + 1,
         failure_reason = NULLIF(v_ly_do, ''),
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_cancelled',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'consent_id',      v_plan.consent_confirmation_id,
    'consent_kind',    v_plan.consent_kind,
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object(
      'ly_do',            v_ly_do,
      'buoc_bo_qua',      v_bo_qua,
      'trang_thai_truoc', v_plan.status)));

  RETURN jsonb_build_object(
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'status',       'CANCELLED',
    'skipped',      v_bo_qua);
END
$huy_ke_hoach$;

COMMENT ON FUNCTION public.copilot_plan_cancel_v1(uuid, int, text) IS
  'Huy ke hoach DRAFT|APPROVED: buoc con cho thanh SKIPPED, tieu phieu dong y neu chua tieu, ghi so '
  'plan_cancelled. KHONG lui thu da ghi — duong lui la rollback_rpc/rollback_note cua tung action.';

REVOKE ALL ON FUNCTION public.copilot_plan_cancel_v1(uuid, int, text) FROM PUBLIC;
DO $quyen_huy$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_cancel_v1(uuid, int, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_cancel_v1(uuid, int, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_cancel_v1(uuid, int, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_cancel_v1(uuid, int, text) TO authenticated;
  END IF;
END
$quyen_huy$;

-- ---------------------------------------------------------------------------
-- 8. RPC 6/6 — ĐỐI SOÁT MỘT BƯỚC (điểm nối #6)
-- ---------------------------------------------------------------------------
--
-- CHỖ TRỐNG CÓ CHỦ Ý, KHÔNG PHẢI HÀM QUÊN VIẾT. Mức 3 mở các action có hiệu ứng
-- NGOÀI database (gửi Zalo, đẩy lệnh xuống router): với chúng, một lần timeout
-- không cho biết việc đã xảy ra hay chưa, nên bước sẽ dừng ở `UNKNOWN_EFFECT` và
-- phải có đường đọc lại nguồn ngoài để chốt. Thân hàm đó là việc của G5-C.
--
-- Nó tồn tại từ hôm nay với ĐẦY ĐỦ chữ ký và ACL vì thứ đắt nhất khi thêm một RPC
-- không phải là thân hàm — mà là chữ ký đi vào `types.ts`, vào lớp gọi RPC, vào
-- test. Trả `not_implemented` (0A000) là câu trả lời trung thực; im lặng trả về
-- một kết quả rỗng thì client sẽ tưởng đã đối soát xong.
CREATE OR REPLACE FUNCTION public.copilot_plan_reconcile_step_v1(
  p_plan_id               uuid,
  p_step_no               int,
  p_expected_plan_version int
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $doi_soat$
BEGIN
  RAISE EXCEPTION 'not_implemented: doi soat buoc UNKNOWN_EFFECT la cua Muc 3 (G5-C)'
    USING ERRCODE = '0A000';
END
$doi_soat$;

COMMENT ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, int, int) IS
  'Diem noi #6 — doi soat mot buoc UNKNOWN_EFFECT voi nguon ngoai. v1 chi RAISE not_implemented '
  '(0A000); than ham la cua G5-C. Chu ky va ACL co san de Muc 3 khong phai doi be mat.';

REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, int, int) FROM PUBLIC;
DO $quyen_doi_soat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, int, int) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, int, int) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, int, int) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid, int, int) TO authenticated;
  END IF;
END
$quyen_doi_soat$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, chạy được trên database rỗng.
--
-- Cố ý KHÔNG thử lập một kế hoạch thật: mọi bảng ở đây đòi `user_id`/
-- `organization_id` có thật, mà Restore Drill replay forward lane lên baseline
-- schema-only thì không có dòng nghiệp vụ nào. Một khối nghiệm thu chết vì thiếu
-- dữ liệu sẽ cuộn ngược cả file và mất luôn mọi object nó vừa tạo.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
  v_can   text[] := ARRAY[
    'public.copilot_plan_create_v1(uuid, text, jsonb)',
    'public.copilot_plan_approve_v1(uuid, text, text, integer, text)',
    'public.copilot_plan_execute_step_v1(uuid, integer, integer, uuid)',
    'public.copilot_plan_get_v1(uuid)',
    'public.copilot_plan_cancel_v1(uuid, integer, text)',
    'public.copilot_plan_reconcile_step_v1(uuid, integer, integer)'
  ];
  v_rieng text[] := ARRAY[
    'app_private.copilot_action_flag_allows_v1(text, uuid)',
    'app_private.copilot_plan_registry_revision_v1()',
    'app_private.copilot_plan_summary_v1(uuid)',
    'app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, integer)'
  ];
BEGIN
  -- (1) Hai bảng kế hoạch.
  FOREACH v_ten IN ARRAY ARRAY['copilot_plans', 'copilot_plan_steps']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'app_private' AND tablename = v_ten
    ) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu bang G3: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (2) Ràng buộc theo hàng: chống-lặp và hình dạng khoá của client.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'copilot_plans_client_request_unique',
    'copilot_plans_client_request_shape'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_ten) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu rang buoc G3: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (3) Sáu RPC public + bốn helper riêng, đúng chữ ký. G3-T4 (planClient.ts)
  -- gọi thẳng những chữ ký này nên chúng là hợp đồng, không phải chi tiết.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY v_can || v_rieng
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G3: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (4) `authenticated` gọi được đúng 6 RPC public, và KHÔNG gọi được helper nào.
  IF to_regrole('authenticated') IS NOT NULL THEN
    v_thieu := '{}'::text[];
    FOREACH v_ten IN ARRAY v_can
    LOOP
      IF NOT has_function_privilege('authenticated', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_thieu := v_thieu || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_thieu) > 0 THEN
      RAISE EXCEPTION 'authenticated khong goi duoc RPC G3: %', array_to_string(v_thieu, ', ');
    END IF;

    v_ho := '{}'::text[];
    FOREACH v_ten IN ARRAY v_rieng
    LOOP
      IF has_function_privilege('authenticated', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'authenticated goi duoc helper G3: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- (5) `anon` không gọi được BẤT CỨ hàm nào của file này.
  IF to_regrole('anon') IS NOT NULL THEN
    v_ho := '{}'::text[];
    FOREACH v_ten IN ARRAY v_can || v_rieng
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G3: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- (6) Hai bảng kế hoạch KHÔNG được lộ cho anon/authenticated: giao diện đọc
  -- qua RPC đã lược bỏ, không đọc bảng.
  IF to_regrole('authenticated') IS NOT NULL THEN
    IF has_table_privilege('authenticated', 'app_private.copilot_plans', 'SELECT')
       OR has_table_privilege('authenticated', 'app_private.copilot_plan_steps', 'SELECT') THEN
      RAISE EXCEPTION 'authenticated doc duoc bang ke hoach — REVOKE khong an';
    END IF;
  END IF;

  -- (7) Cờ `action:copilot.execution_plan` phải có mặt và file này KHÔNG được
  -- chạm vào trạng thái của nó (20260903043956 gieo `disabled`; bật là việc của
  -- đợt rollout, kèm reason/evidence qua RPC CAS).
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'copilot.execution_plan'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: copilot.execution_plan';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
