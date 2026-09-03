-- G3-T1 (phụ) — LỐI VÀO cho đường `maker_submit_v1`: hàng registry
-- `income_expense.nop_ho_so` + một dòng cờ kill switch ở trạng thái `disabled`.
--
-- VÌ SAO ĐÂY LÀ MỘT FILE RIÊNG
--   `20260903100253_copilot_execution_plan_v1` dựng KHUNG kế hoạch thực thi, và
--   trong khung đó `executor_kind = 'maker_submit_v1'` đã được hiện thực đầy đủ
--   (giải `{$ref_step:n}` và `{voucher_id}` lúc lập, giải tham chiếu từ
--   `outcome.entity_id` lúc chạy, helper `copilot_plan_submit_voucher_v1` nộp hồ
--   sơ). Nhưng registry không có hàng nào khai `maker_submit_v1`, nên đường đó là
--   mã KHÔNG CÓ LỐI VÀO.
--
--   Luật của repo là mỗi action một migration forward riêng, và một hàng **L5**
--   xứng đáng được review một mình chứ không lẫn vào 2100 dòng dựng khung. File
--   này làm đúng một việc: mở lối vào, ở trạng thái TẮT.
--
-- ĐÂY KHÔNG PHẢI ĐƯỜNG DUYỆT PHIẾU
--   `copilot_plan_submit_voucher_v1` NỘP một phiếu nháp vào engine duyệt và ép hồ
--   sơ dừng ở `PENDING_APPROVAL`. Nếu bộ luật của tổ chức khớp `AUTO_POST` thì
--   `submit_financial_voucher` sẽ tự hạch toán ngay trong lời gọi — helper phát
--   hiện điều đó qua readback và ném `copilot_auto_post_forbidden`, để khối con
--   của `copilot_plan_execute_step_v1` cuốn ngược sạch cả bút toán lẫn hồ sơ.
--   `DENY` ném `rule_denied`. Người duyệt vẫn là CON NGƯỜI khác, qua
--   `decide_financial_voucher`, vốn chặn chính người nộp (maker-checker).
--
--   Vì thế `risk = 'L5'` (đụng hàng chờ duyệt tài chính) nhưng
--   `consent_required = 'click'`: thứ người dùng đồng ý là "nộp hồ sơ", không
--   phải "duyệt chi". Trần rủi ro `copilot_action_policy.max_direct_risk` hiện là
--   'L4', và `copilot_plan_create_v1` MIỄN trần cho đúng một `executor_kind` là
--   `maker_submit_v1` — miễn theo cơ chế thực thi, không theo mức rủi ro.
--
-- VÌ SAO `preview_rpc` VÀ `execute_rpc` CÙNG MANG MỘT TÊN, VÀ TẠI SAO KHÔNG SAO
--   Hai cột đó NOT NULL vì chúng là hợp đồng của `nonce_abi_v1`. Với
--   `maker_submit_v1` thì không có cặp preview/execute nào: máy kế hoạch rẽ
--   nhánh theo `executor_kind` TRƯỚC, và trong nhánh này nó gọi thẳng
--   `app_private.copilot_plan_submit_voucher_v1(org, voucher, plan, step)` —
--   không có `EXECUTE format(...)` nào đọc hai cột này.
--
--   Khai đúng tên helper (thay vì một chuỗi giả như 'khong_dung') là lựa chọn có
--   chủ ý: hai cột này là thứ người đọc registry dùng để trả lời "action này
--   chạy bằng gì", và một chuỗi giả sẽ nói dối họ. Đổi lại, nếu về sau ai đó viết
--   một nhánh mới đọc `preview_rpc` mà không rẽ theo `executor_kind`, lời gọi sẽ
--   THẤT BẠI TO (`public.copilot_plan_submit_voucher_v1` không tồn tại — helper
--   nằm ở `app_private` và nhận 4 tham số), chứ không âm thầm chạy nhầm hàm.
--   Hỏng to ở đây tốt hơn hỏng im.
--
-- HAI CHECK THEO HÀNG CỦA REGISTRY — hàng này qua cả hai:
--   `copilot_action_registry_l5_row_check`: tên `copilot_plan_submit_voucher_v1`
--     KHÔNG khớp `(approve|decide|_post_|posting|delete|remove|reverse|grant|
--     revoke|permission|role)`, nên vế đầu của phép hoặc đã đúng — hàng hợp lệ mà
--     không cần khai `direct_l5_v1`/`step_up`.
--   `copilot_action_registry_l6_forbidden`: không có sql/secret/deploy/migration/
--     drop/truncate/pg_ trong tên nào.
--   `copilot_action_registry_flag_matches_action`: `flag_contract_id = action_id`.
--   `copilot_action_registry_rpc_name_shape`: khớp `^[a-z0-9_]+(\.[a-z0-9_]+)?$`.
--
-- `permission_key = 'income_expenses.create'` — ĐÃ KIỂM, KHÔNG PHẢI ĐOÁN
--   `submit_financial_voucher` (20260713130200:62) không đo một khoá quyền nào:
--   nó chỉ đòi membership ACTIVE trong tổ chức của phiếu (hoặc super admin), rồi
--   giao phần còn lại cho bộ luật duyệt. Và nó KHÔNG có màn hình nào gọi: quét
--   toàn bộ `src/` ngày 03/09/2026 chỉ thấy nó trong `types.ts`.
--
--   Nên khoá quyền của hàng này phải trả lời câu "quyền nào ĐANG được thực thi",
--   và câu trả lời là quyền TẠO: helper chỉ nộp được một phiếu do CHÍNH người
--   thao tác tạo (`user_id = auth.uid()`), còn UNAPPROVED/UNPOSTED, chưa có hồ sơ
--   mở. Đó đúng bằng thẩm quyền mà `income_expense.create_draft` đã dùng
--   (`income_expenses.create`), nên một kế hoạch `tạo nháp → nộp hồ sơ` đi qua
--   hai cổng bằng cùng một quyền, không phát sinh thẩm quyền mới ở giữa.
--
--   `income_expenses.approve` là khoá của NGƯỜI DUYỆT. Đặt nó ở đây sẽ đòi actor
--   có quyền duyệt mới nộp được hồ sơ — vừa sai nghiệp vụ, vừa là bước đầu tiên
--   trên con đường mà cả kiến trúc L5 dựng ra để chặn.
--
-- `consumes_ref_table = 'income_expenses'` là thứ làm `{$ref_step: n}` chạy được:
--   `copilot_plan_create_v1` đòi `produces_entity_table` của bước n phải BẰNG
--   `consumes_ref_table` của bước này, và `income_expense.create_draft` sinh ra
--   `income_expenses`.
--
-- ĐƯỜNG LÙI
--   DELETE hàng registry `income_expense.nop_ho_so` và hàng cờ
--   `('action','income_expense.nop_ho_so')`. Không hàm nào được tạo hay sửa ở
--   đây, không dữ liệu nghiệp vụ nào phụ thuộc.
--
-- CỜ GIEO Ở `disabled` — file này KHÔNG bật gì. Bật là việc của đợt rollout T9,
-- qua `set_copilot_feature_flag_v2` (CAS, bắt buộc reason/evidence/rollback).

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. TIỀN ĐỀ — nói to tên file thiếu thay vì để lỗi hiện ra như "quan hệ không tồn tại"
-- ---------------------------------------------------------------------------
DO $tien_de$
BEGIN
  IF to_regclass('app_private.copilot_action_registry') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_registry missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regclass('public.copilot_feature_flags') IS NULL THEN
    RAISE EXCEPTION 'copilot_feature_flags missing — 20260828170000 phai chay truoc';
  END IF;
  -- MÁY KẾ HOẠCH: phụ thuộc LOGIC, không phải phụ thuộc CẤU TRÚC — và hai thứ
  -- đó đáng được đối xử khác nhau.
  --
  --   Hàng registry này là DỮ LIỆU. Nó chèn được, và `copilot_action_gate_v1`
  --   đọc được, mà không cần một dòng nào của 20260903100253. Cái nó mô tả —
  --   nhánh `maker_submit_v1` — mới cần máy kế hoạch, và không có máy đó thì
  --   hàng này đơn giản là nằm yên: không RPC nào đọc `executor_kind`, và cờ
  --   vẫn `disabled`.
  --
  --   Nên vế BẮT BUỘC ở đây là trạng thái NỬA VỜI: máy kế hoạch đã có bảng
  --   nhưng thiếu helper nộp hồ sơ. Đó là dấu hiệu 20260903100253 chạy dở dang,
  --   và một hàng registry trỏ vào một helper không tồn tại là cái bẫy im lặng
  --   đúng nghĩa. Còn máy kế hoạch VẮNG HẲN chỉ có nghĩa file này đang được
  --   dry-run trước khi anh nó được apply — forward lane chạy theo tên file
  --   (100253 < 102931) nên thứ tự thật luôn đúng.
  IF to_regclass('app_private.copilot_plans') IS NOT NULL
     AND to_regprocedure('app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, integer)') IS NULL THEN
    RAISE EXCEPTION
      'copilot_plan_submit_voucher_v1 missing trong khi bang ke hoach da co — 20260903100253 chay do dang';
  END IF;
  IF to_regclass('app_private.copilot_plans') IS NULL THEN
    RAISE WARNING
      'may ke hoach (20260903100253) chua apply — hang registry income_expense.nop_ho_so se nam yen cho toi khi no chay';
  END IF;
END
$tien_de$;

-- ---------------------------------------------------------------------------
-- 1. HÀNG REGISTRY
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled
)
VALUES (
  'income_expense.nop_ho_so',
  1,
  'Nộp phiếu thu/chi vào hộp chờ duyệt',
  'income_expenses.create',
  'L5',
  'maker_submit_v1',
  'click',
  -- Hai cột NOT NULL của hợp đồng `nonce_abi_v1`. Nhánh `maker_submit_v1` gọi
  -- thẳng helper và KHÔNG đọc hai cột này — xem khối giải thích ở đầu file.
  'copilot_plan_submit_voucher_v1',
  'copilot_plan_submit_voucher_v1',
  'approval_request_pending',
  'approval_requests',
  'income_expenses',
  NULL,
  'Rut ho so qua giao dien duyet (WITHDRAWN/CANCELLED); phieu goc quay lai UNAPPROVED/UNPOSTED va co the nop lai',
  'income_expense.nop_ho_so',
  true
)
ON CONFLICT (action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. CÔNG TẮC — gieo TẮT
-- ---------------------------------------------------------------------------
-- Trigger v2 (`copilot_feature_flags_bump_revision`, 20260829030000) từ chối mọi
-- INSERT/UPDATE không mang dấu giao dịch này — đó chính là thứ ép mọi thay đổi
-- lúc chạy phải đi qua RPC CAS. Seed trong migration là đường hợp lệ còn lại,
-- nên nó tự khai dấu.
SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'income_expense.nop_ho_so', 'disabled',
  'seed kill switch cho action L5 nop phieu thu/chi vao hop cho duyet (G3-T1 phu)',
  'migration:20260903102931_copilot_action_income_expense_nop_ho_so_v1',
  'migration:20260903102931_copilot_action_income_expense_nop_ho_so_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog và hai hàng vừa gieo; chạy được trên DB rỗng.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_row app_private.copilot_action_registry%ROWTYPE;
BEGIN
  SELECT * INTO v_row
    FROM app_private.copilot_action_registry
   WHERE action_id = 'income_expense.nop_ho_so';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seed registry income_expense.nop_ho_so thieu';
  END IF;

  -- Từng trường một. Một hàng khai lệch không làm migration đỏ ở tầng CHECK
  -- (mọi giá trị sai vẫn hợp lệ về kiểu), nên chỗ duy nhất bắt được là ở đây.
  IF v_row.risk IS DISTINCT FROM 'L5'
     OR v_row.executor_kind IS DISTINCT FROM 'maker_submit_v1'
     OR v_row.consent_required IS DISTINCT FROM 'click'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.create'
     OR v_row.verify_kind IS DISTINCT FROM 'approval_request_pending'
     OR v_row.produces_entity_table IS DISTINCT FROM 'approval_requests'
     OR v_row.consumes_ref_table IS DISTINCT FROM 'income_expenses'
     OR v_row.rollback_rpc IS NOT NULL
     OR v_row.enabled IS DISTINCT FROM true
     OR v_row.version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'seed registry income_expense.nop_ho_so sai hinh: risk=%, executor=%, consent=%, perm=%, verify=%, produces=%, consumes=%',
      v_row.risk, v_row.executor_kind, v_row.consent_required, v_row.permission_key,
      v_row.verify_kind, v_row.produces_entity_table, v_row.consumes_ref_table;
  END IF;

  -- `flag_contract_id = action_id` đã có CHECK, nhưng khẳng định lại ở đây làm
  -- rõ vì sao nó quan trọng: lệch một chữ là kill switch bấm một chỗ, tắt một
  -- chỗ khác.
  IF v_row.flag_contract_id IS DISTINCT FROM v_row.action_id THEN
    RAISE EXCEPTION 'flag_contract_id lech action_id';
  END IF;

  -- Bước trước trong một kế hoạch `tao nhap -> nop ho so` phải SINH RA đúng thứ
  -- bước này TIÊU THỤ, nếu không `{$ref_step:n}` sẽ bị từ chối lúc lập kế hoạch.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry r
     WHERE r.action_id = 'income_expense.create_draft'
       AND r.produces_entity_table = v_row.consumes_ref_table
  ) THEN
    RAISE EXCEPTION 'chuoi $ref_step vo nghia: income_expense.create_draft khong sinh ra %',
      v_row.consumes_ref_table;
  END IF;

  -- Cờ phải có mặt và phải ĐANG TẮT. Một hàng cờ gieo ở trạng thái mở là một
  -- công tắc đã ở vị trí "bật" trước khi có ai kiểm tra dây.
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action'
       AND f.contract_id = 'income_expense.nop_ho_so'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: income_expense.nop_ho_so';
  END IF;

  -- Helper mà hàng này mô tả: khi nó ĐÃ có thì phải đúng chữ ký bốn tham số ở
  -- `app_private` (uuid org, uuid phiếu, uuid kế hoạch, int bước). Khi máy kế
  -- hoạch chưa apply thì không kiểm — xem khối tiền đề ở đầu file.
  IF to_regclass('app_private.copilot_plans') IS NOT NULL
     AND to_regprocedure('app_private.copilot_plan_submit_voucher_v1(uuid, uuid, uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_submit_voucher_v1 sai chu ky hoac thieu';
  END IF;
END
$nghiem_thu$;

COMMIT;
