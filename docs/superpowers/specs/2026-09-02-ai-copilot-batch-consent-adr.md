# ADR — AI Copilot: đổi từ per-action consent sang batch consent (Mức 2 → Mức 3)

**Ngày:** 2026-09-02 · **Trạng thái:** Chủ dự án đã chốt (hội thoại 02/09/2026) · **Loại:** đổi quyết định thiết kế đã ghi trong spec gốc

## Bối cảnh

Spec gốc `2026-08-13-ai-copilot-superadmin-control-design.md` (§12, dòng ~1028) và plan LEAN Op1
đã chốt mô hình **per-action consent**: mỗi bước ghi (preview → xác nhận → execute) đòi nonce và
sự đồng ý riêng của người dùng, kể cả superadmin — nguyên văn "khong co global consent cho ca
plan, ke ca superadmin". Đây vẫn là hạ tầng đang chạy: `copilot_preview/execute_income_expense_v1`
(migration `20260830171108`) dùng nonce từng bước qua `app_private.copilot_write_confirmations`.

Audit vòng 2 (02/09/2026) đo được: production mới có 1 tool ghi (`tao_phieu_thu_chi_nhap`, draft
UNAPPROVED), 24% route có tool đọc, 3% có tool ghi — per-action consent đúng nhưng không đủ để mở
rộng Copilot thành trợ lý toàn site, vì mỗi thao tác ghi lặp lại vẫn đòi một cú bấm riêng.

## Quyết định 02/09/2026

Chủ dự án chốt lộ trình 3 mức, thay cho per-action consent thuần:

1. **Mức 2 (diễn tập)** — batch consent: người dùng duyệt **KẾ HOẠCH** (nhiều bước) một lần bằng
   một nonce plan-level (`app_private.copilot_write_confirmations`, `tool='lap_ke_hoach'`), server
   re-check quyền cho từng bước ngay trước khi execute chứ không tin lại phê duyệt cũ. Phạm vi mở
   ở Mức 2: risk **≤ L4** (thao tác ghi thường, đảo ngược được). Risk **L5** (duyệt tiền, vào sổ,
   xoá, đổi quyền) đi đường khác: AI chỉ là **maker** nộp hồ sơ vào approval engine sẵn có, người
   thật vẫn là **checker** duyệt (`submit_financial_voucher` → `decide_financial_request_v2`).
2. **Mục tiêu thật là Mức 3** — AI toàn quyền **L5** như một superadmin ngồi bấm (duyệt, vào sổ,
   xoá, phân quyền, cấu hình công ty, Zalo hàng loạt, thao tác router), mở bằng **step-up PIN 4
   số** cho từng lượt L5 cộng **uỷ quyền đứng (standing grant)** cho việc lặp lại trong phạm vi đã
   cấp. **L6** (SQL thô, secret, deploy, migration) **vĩnh viễn ngoài Copilot** — vẫn chỉ qua Claude
   Code/Hermes, không đổi.
3. Chỉ **superadmin** trước; vai khác rollout sau qua flag/policy, không hard-code trong RPC.

## 10 điểm nối để Mức 2 → Mức 3 là mở rộng, không rebuild

Lấy từ Phần B0 của plan `2026-09-02-ai-copilot-va-nen-den-toan-quyen-muc-3.md` — làm sẵn ngay ở
migration đầu tiên của Giai đoạn 3 (G3), nếu bỏ sót thì Mức 3 phải DROP+CREATE RPC / sửa CHECK /
sửa máy trạng thái:

1. CHECK theo hàng trên registry: hàm L5 (approve/post/delete/permission) chỉ hợp lệ khi
   `risk='L5' AND executor_kind='direct_l5_v1' AND consent_required='step_up'`; pattern L6
   (sql/secret/deploy/migration…) cấm tuyệt đối.
2. Bảng `app_private.copilot_action_policy` (singleton, `max_direct_risk` L4→L5) thay hard-code.
3. Tham số `p_step_up_token` có sẵn từ v1 trên `copilot_plan_approve_v1` (NULL ở Mức 2).
4. Máy trạng thái có sẵn nhánh server tự APPROVE khi mọi bước được standing grant phủ.
5. Cột `rollback_rpc`/`rollback_note` nullable từ v1 trên registry.
6. Enum step có `UNKNOWN_EFFECT` + slot RPC `copilot_plan_reconcile_step_v1` (v1 chỉ RAISE
   `not_implemented`).
7. Helper `copilot_plan_role_allowed_v1(org)` đọc `policy.allowed_roles` thay vì `is_super_admin()`
   rải rác.
8. Ledger có cột `consent_kind, step_up_id, grant_id` từ v1.
9. Gate CI đọc `tooling/copilot-action-policy.json` (forbidden/step_up_required/allowed) thay vì
   hard-code danh sách cấm.
10. `direct_l5_v1` bọc `approve_income_expense_v1` cho phép người tạo tự duyệt phiếu AI vừa tạo
    (baseline `45732`, chặn phiếu đã vào engine ở `45718`) — PIN của người thật đóng vai checker.

## Hệ quả với spec gốc

`2026-08-13-ai-copilot-superadmin-control-design.md` §12 dòng ~1028 ("khong co global consent cho
ca plan, ke ca superadmin") **bị thay** bởi ADR này cho phạm vi risk ≤ L4 (Mức 2) và cho L5 dưới
step-up PIN (Mức 3). Task này **không sửa nội dung spec gốc** — chỉ thêm 1 dòng banner ngay dưới
tiêu đề trỏ về ADR; nội dung §12 giữ nguyên làm hồ sơ lịch sử của quyết định trước đó.

## Rủi ro chấp nhận

- **PIN 4 số chỉ có 10.000 tổ hợp** — chấp nhận vì đi kèm khoá cứng: sai 5 lần khoá 15 phút, tăng
  gấp đôi mỗi đợt khoá tiếp theo, mọi lần thử (đúng/sai) ghi ledger. PIN không bao giờ đi qua
  chat/tool/model context — chỉ nhập trong modal UI riêng.
- **PIN của superadmin đóng vai checker cho phiếu chính AI vừa tạo** (`direct_l5_v1` bọc
  `approve_income_expense_v1`), không phải một người thứ hai độc lập — đây là đánh đổi có ý thức
  để không phải dựng thêm một vai duyệt mới; mọi lượt vẫn ghi `permission_snapshot` + digest vào
  ledger bất biến, và phiếu đã lọt vào approval engine của người khác thì `direct_l5_v1` bị chặn
  (không tự duyệt hồ sơ không phải của mình).
- **Mức 2 hiện đang thi công trên nhánh `copilot/g0-va-nen` (G0), chưa merge/apply** — mọi mô tả
  trong ADR này là hướng đi đã chốt, không phải trạng thái production. Xem plan
  `2026-09-02-ai-copilot-va-nen-den-toan-quyen-muc-3.md` Phần A cho trạng thái đo được thật.
