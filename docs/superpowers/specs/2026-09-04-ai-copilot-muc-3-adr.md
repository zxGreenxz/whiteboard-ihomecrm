# ADR — AI Copilot Mức 3: PIN step-up, uỷ quyền đứng, ranh giới L5/L6

**Ngày:** 2026-09-04 · **Trạng thái:** Chốt cho phần CODE (task G5-D/E); phần BẬT VAN production do
controller thực hiện riêng, không thuộc ADR này · **Loại:** ADR mới, kế thừa
[`2026-09-02-ai-copilot-batch-consent-adr.md`](2026-09-02-ai-copilot-batch-consent-adr.md)

## Bối cảnh

ADR 02/09/2026 chốt lộ trình 3 mức và 10 điểm nối để Mức 2 (batch consent, risk ≤ L4) mở rộng
thành Mức 3 (L5 toàn quyền dưới step-up PIN) mà không phải rebuild. G3→G5-C đã thi công đúng 10
điểm nối đó trên nhánh `copilot/g0-va-nen`, tính tới HEAD `166e6dee` (đã lên production):

- **G5-A** (`20260903150311`): PIN 4 số theo NGƯỜI DÙNG (không theo tổ chức), băm bcrypt, khoá
  5-lần-sai leo thang, `copilot_step_up_verify_v1` phát token một lần tiêu qua
  `copilot_write_confirmations`; `copilot_plan_approve_v1` nhận `p_step_up_token`.
- **G5-B** (`20260903171622`): uỷ quyền đứng (standing grant) — `copilot_standing_grants`
  (`max_per_day`, `used_today`, `expires_at ≤ created_at + 30 ngày`, `reason` bắt buộc,
  `created_with_step_up_id` NOT NULL); cột `grantable` trên registry, **mặc định `false`** (fail-
  closed, fix round 1 F1); `copilot_plan_create_v1` tự APPROVE một kế hoạch khi MỌI bước được một
  grant còn sống phủ đủ (`max_amount`/`building_ids` khi bước có trường tương ứng).
- **G5-C** (8 migration, đợt 1): tám hành động `direct_l5_v1` bọc RPC L5 có sẵn (duyệt/vào sổ/xoá
  mềm phiếu thu-chi, hoá đơn, chỉ số công tơ, thanh lý hợp đồng, khách hàng) — mỗi hành động là
  một cặp `copilot_preview_<x>_v1`/`copilot_execute_<x>_v1` theo khuôn Nonce ABI v1, cộng một kiểm
  DATABASE THẬT (`app_private.copilot_l5_plan_context_ok_v1`, fix round 1 F1) rằng execute chỉ
  chạy khi có một bước PENDING của một kế hoạch APPROVED thật của đúng actor, đúng org, đúng
  action — gọi `execute_rpc` ngoài khuôn đó ⇒ `l5_requires_plan`.
- **G5-D** (task này): gate CI đọc đúng ngữ nghĩa `step_up_required` (không còn coi nó y hệt
  `forbidden`), và văn bản quyết định dưới đây.

`max_direct_risk` policy vẫn `L4` tại thời điểm viết ADR — G5-D không tự bật van production; đó là
việc riêng của controller (mục "Bật van" bên dưới).

## Quyết định

### 1. PIN của superadmin là **checker**, không phải người thứ hai độc lập

Mọi hành động `direct_l5_v1` (duyệt tiền, vào sổ, xoá hoá đơn/khách hàng, thanh lý hợp đồng) chỉ
chạy được sau khi **chính người đang thao tác Copilot** nhập đúng PIN 4 số của họ trong
`StepUpPinModal` — không phải một người khác duyệt hộ. Đây là đánh đổi có chủ ý, kế thừa nguyên
văn từ ADR 02/09: dựng thêm một vai duyệt độc lập cho MỌI thao tác AI tạo ra là một hạng mục lớn
hơn hẳn phạm vi Mức 3, và không xoá được rủi ro gốc (một superadmin bị chiếm quyền phiên vẫn có
thể tự duyệt việc chính họ vừa yêu cầu AI làm — PIN chỉ nâng chi phí, không loại trừ). Điều PIN
thật sự đổi là **chi phí của một request bị đánh cắp/giả mạo từ mô hình**: nếu chat bị chiếm hoặc
mô hình bị injection, kẻ tấn công vẫn cần lấy được 4 số không đi qua chat/tool/model context (chỉ
nhập trong modal UI riêng, `type="password"`, không log). Mọi lượt PIN (đúng/sai/khoá) ghi
`app_private.copilot_action_ledger` bất biến, kèm `permission_snapshot`; hồ sơ đã lọt vào approval
engine của người khác (qua `income_expense.nop_ho_so`, maker-checker thật) thì `direct_l5_v1`
KHÔNG dùng — hai đường không trộn.

### 2. L6 (`sql`/`secret`/`deploy`) ở NGOÀI Copilot vĩnh viễn — không đàm phán ở Mức 3

`L6_FOREVER` (`scripts/check-copilot-forbidden-actions.mjs`) neo bằng HẰNG SỐ TRONG MÃ, không đọc
lại từ chính file policy đang bị nó kiểm — một PR xoá dòng khỏi `tooling/copilot-action-policy.json`
làm gate NÉM, không làm gate mù. Không PIN, không uỷ quyền đứng, không cấu hình nào hạ được ba kind
này xuống `step_up_required`. SQL thô, secret, deploy/migration vẫn chỉ đi qua Claude Code/Hermes —
con người tại bàn phím, không qua chat Copilot dưới bất kỳ hình thức nào.

### 3. Uỷ quyền đứng: trần 30 ngày, KHÔNG BAO GIỜ cấp cho hành động phân quyền

`copilot_standing_grants.expires_at ≤ created_at + interval '30 days'` là một CHECK ở tầng bảng
(không phải quy ước tầng ứng dụng) — một grant "vĩnh viễn" không thể tồn tại kể cả khi RPC tạo bị
bỏ qua. `grantable` trên registry mặc định `false` (fail-closed); tại thời điểm viết ADR chỉ 6
hành động L3/L4 được mở tường minh (`income_expense.annotate`, `reservation.set_hold_terms`,
`zalo.set_conversation_flags`, `meter_reading.create`, `reservation_deposit.create`,
`income_expense.create_draft`) — **không hành động nào trong tám hành động `direct_l5_v1`, và
không một action nào mang `permission.action` thuộc nhóm cấp/thu quyền, nằm trong danh sách này**.
Registry hiện tại còn chưa có bất kỳ hành động "đổi quyền" nào được bọc cho Copilot (không có
kind `permission` trong `ACTION_CATALOG`); nếu một hành động như vậy được thêm trong tương lai,
quyết định này BẮT BUỘC nó giữ `grantable = false` — một AI tự cấp quyền lặp lại cho chính nó
(dù thông qua một grant do người thật tạo một lần) là đúng hình dạng rủi ro leo thang đặc quyền mà
kiến trúc L5 dựng ra để chặn, khác về bản chất với việc lặp lại một khoản chi/một ghi chú đã có
hạn mức rõ ràng. Thu hồi (một cái hoặc `revoke_all`) không đòi PIN — hạ quyền luôn dễ hơn cấp.

### 4. Báo cáo ngày

`copilot_standing_grants_daily_report_v1` (G5-B, super admin) trả số kế hoạch tự duyệt theo uỷ
quyền + tổng tiền VND trong ngày, đọc trong thẻ "Uỷ quyền đứng" (`HanhDongTab.tsx`). Đây là điểm
quan sát bắt buộc trước khi mở rộng danh sách `grantable`: một ngày có số lượng tự-duyệt bất
thường là tín hiệu đầu tiên, không phải sau-sự-cố. `scripts/copilot-ledger-audit.mjs` (G5-E,
deliverable 5) bổ sung một lớp đối chiếu độc lập với chính báo cáo đó — không tin một nguồn số duy
nhất cho một cơ chế có thể tự duyệt.

### 5. Ba công tắc dừng khẩn (kill switch), độc lập nhau

Không cái nào phụ thuộc cái còn lại — hỏng một cái không vô hiệu hai cái kia:

1. **Flag rollout `copilot.execution_plan`** (`CONTRACT_KE_HOACH`, `src/copilot/featureFlags.ts`) —
   tắt flag này thì `lap_ke_hoach`/`thuc_thi_buoc` biến mất khỏi cả `toLlmTools` lẫn
   `toPageAgentTools` (rolloutKey trên cả hai tool). Không kế hoạch nào tạo được, dù risk nào.
   Đây là công tắc THÔ nhất — tắt cả Mức 2 lẫn Mức 3 cùng lúc.
2. **`copilot_standing_grants_revoke_all_v1`** — thu hồi MỌI grant đang sống của một tổ chức trong
   một lời gọi, đòi lý do ≥ 10 ký tự. Không đụng `max_direct_risk`/PIN — chỉ đóng đường tự-duyệt-
   theo-uỷ-quyền, đường PIN-mỗi-lượt vẫn chạy bình thường (đây là điểm khác biệt có chủ ý so với
   flag ở trên: dùng khi nghi ngờ MỘT cơ chế, không phải toàn bộ Copilot).
3. **Đảo ngược policy** — `set_copilot_action_policy_v1(p_expected_revision, p_max_direct_risk='L4', ...)`
   hạ trần rủi ro về L4: mọi kế hoạch đang tạo mới với bước L5 bị chặn ngay ở
   `copilot_plan_create_v1` (`plan_risk_not_allowed`), và mọi bước L5 đang CHỜ CHẠY của một kế
   hoạch đã duyệt trước đó bị `copilot_plan_execute_step_v1` chặn ở lượt kiểm van ngay trước ghi
   (`policy_changed`) — không có "đã duyệt rồi thì chạy tuột". CAS qua `p_expected_revision` chống
   ghi đè mù giữa hai admin sửa policy đồng thời.

Cả ba đều KHÔNG đụng vào `L6_FOREVER` — không công tắc nào, kể cả tắt tất cả cùng lúc, có thể MỞ
được SQL/secret/deploy; ba kind đó không nằm trong không gian mà các công tắc này điều khiển.

## Hệ quả với ADR 02/09 và spec gốc

ADR này KHÔNG thay đổi quyết định 02/09 (batch consent, ba mức, chỉ superadmin trước) — nó là văn
bản CHỐT cho các chi tiết mà ADR đó để ngỏ ("mở bằng step-up PIN... cộng uỷ quyền đứng") sau khi
G5-A/B/C đã thi công xong phần cơ chế. `2026-08-13-ai-copilot-superadmin-control-design.md` §12
tiếp tục là hồ sơ lịch sử, không sửa.

## Bật van (thuộc controller, KHÔNG thuộc phạm vi code của task này)

`set_copilot_action_policy_v1(max_direct_risk='L5', standing_grants_enabled=true, ...)` qua đăng
nhập super admin thật, cờ từng hành động L5 đi qua canary `disabled → shadow → enabled` với
`expires_at` trên DEMO trước, tổ chức thật chỉ sau khi canary sạch. Tại thời điểm ADR này được
viết, van vẫn ở trạng thái tắt (`max_direct_risk='L4'`) — mọi ví dụ "chạy thật" trong E2E
`copilot-plan-l5-matrix.spec.ts` đi kèm task này đều bị SKIP có lý do cho tới khi controller bật.

## Rủi ro chấp nhận (bổ sung so với ADR 02/09)

- **10.000 tổ hợp PIN** vẫn là rủi ro đã ghi ở ADR 02/09, không đổi — khoá leo thang + ledger bất
  biến là lớp giảm thiểu, không phải triệt tiêu.
- **`grantable` sai một lần là sai vĩnh viễn cho tới khi bị phát hiện**: một migration tương lai mở
  `grantable=true` cho một hành động không nên mở sẽ không bị CHECK tầng bảng nào chặn (CHECK ở
  G5-C chỉ ràng `direct_l5_v1` với `risk='L5' AND consent_required='step_up' AND grantable=false`,
  không ràng các hành động L3/L4). Hàng rào thật là review người + `copilot-ledger-audit.mjs` chạy
  định kỳ, không phải một bất biến CSDL không thể phá.
- **Báo cáo ngày là ĐỌC, không phải CHẶN** — một ngày bất thường không tự dừng cơ chế; người đọc
  báo cáo phải tự bấm một trong ba công tắc ở mục 5.
