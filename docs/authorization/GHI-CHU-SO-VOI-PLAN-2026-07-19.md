# GHI CHÚ TỔNG KIỂM SO VỚI AUTHORIZATION-PLAN.md — 2026-07-19 (tối)

**Cách kiểm:** 26 agent song song (9 đối chiếu từng mục plan ↔ code+DB thật · 15 kiểm
thử lại chức năng bằng REST/psql · 1 hạm đội **30 browser ẩn** trên production ·
1 agent **phản biện độc lập** tự xác minh lại mọi phát hiện — CONFIRMED/REFUTED).
2,85 triệu token, 1.021 tool-call. Tiền org thật bất biến `3.891.819.563` xuyên suốt.

**Điểm số verdict (26 suite):** PASS 124 · DONE 56 · PARTIAL 51 · MISSING 46 ·
DIFFERENT 36 · BLOCKED 9 · FAIL 8 → sau phản biện: **3 FAIL thật** (đã vá trong
ngày, xem §3) + 2 claim bị bác (hệ thống thực tế ổn hơn báo cáo).

---

## 1. ĐÃ HOÀN THÀNH & KIỂM CHỨNG SỐNG (retest hôm nay, sau go-live)

| Domain | Kết quả |
|---|---|
| Phiếu thu/chi theo phương án mới | 6/6 + 11/11 PASS: dưới ngưỡng tự duyệt, ≥ ngưỡng thành Nháp, hạng mục đặc biệt luôn Nháp, thu tay không áp ngưỡng, freeze chặn sửa raw, vòng đời huỷ/duyệt |
| Hoá đơn tạo + thu + hoàn | 14/14 PASS (rounding, credit, partial→paid, hoàn tác idempotent, chặn hoàn-2-lần) |
| Trạng thái hoá đơn + force-cancel | 17/20 → 20/20 sau vá bug D3 (xem §3) |
| Chuỗi lương | 9/9 PASS (maker→duyệt→POSTED→gạch "đã trả", cấn trừ tiền phòng đúng số, guard chốt-lợi-nhuận-trước D2b) |
| Chuỗi lợi nhuận | 6/6 PASS (chốt/mở, chia cổ đông, chi quản lý — maker bị loại khỏi ứng viên duyệt) |
| Sổ quỹ | 7/7 PASS (tạo + auto-bind người-giữ-quỹ, khoá kỳ + guard lùi ngày, lưu trữ, điều chỉnh đầu kỳ theo possession) |
| Hợp đồng + khoá giữ-phòng | 6/6 PASS (hold độc quyền 24h, HĐ tiêu thụ hold, thanh lý sinh phiếu hoàn cọc ở Nháp) |
| Engine duyệt — đường từ chối | 5/5 PASS (REJECT, verb lạ, CAS version, maker-checker) |
| Cách ly tenant + storage | 9/9 + 6/6 PASS (đọc chéo org rỗng, RPC chéo 42501, ảnh CCCD org thật không tải/sign được từ demo) |
| Đối soát tiền | 6/7 → 7/7 sau dọn residue demo (org thật khớp tuyệt đối từng hoá đơn) |
| Cấu hình 15 flag + quyền org thật | PASS (15/15 ON, route CANONICAL cả 2 org, ma trận quyền 4 người đúng vai) |
| Browser 30 luồng ẩn | 16/17 pass lần đầu (1 flake mạng retry OK); bundle mới live; thẻ "Ngưỡng tự duyệt phiếu chi" hiển thị đúng |

## 2. KHÁC BIỆT CHỦ ĐÍCH so với plan gốc (quyết định owner đè plan — KHÔNG phải lỗi)

| Plan gốc viết | Thực tế đang chạy (theo lệnh owner) |
|---|---|
| Không khớp luật ⇒ bắt buộc duyệt (fail-closed) | Phiếu thường **tự duyệt khi tạo**; chỉ hạng mục đặc biệt (cờ trên 43 hạng mục: hoàn cọc/thanh lý/Tiền thối/lương/LN/hoa hồng/thưởng/HHMG) + **phiếu chi ≥ ngưỡng cài trong Cài đặt** mới thành Nháp |
| Maker không bao giờ tự duyệt | Phiếu thường: người tạo = người duyệt lúc sinh (chủ đích). Lương/LN vẫn maker-checker qua engine |
| Nhập Excel qua duyệt | Giữ tự duyệt (nhập lịch sử) |
| Caps canary theo số tiền/số lượng | Caps chỉ còn ở flag income_expense + payment; các writer khác không đếm — an toàn thật nằm ở writer + fallback (flag đã ON nên caps không còn vai trò) |
| TENANT_OWNER allowlist hẹp | Owner được materialize **toàn bộ 214 permission** (go-live một phát). Lưu ý: permission key MỚI sau này phải nhớ grant |
| D3 chặn huỷ khi còn phiếu thu | Áp ở **force-cancel v2**; nút huỷ thường (cancel_invoice_v1) mirror legacy không guard — muốn phủ cả huỷ thường cần owner gật (tranche riêng) |
| Ngưỡng | **Org thật CHƯA đặt ngưỡng** (= tự duyệt mọi phiếu chi thường). Owner vào Cài đặt → Thu chi → "Ngưỡng tự duyệt phiếu chi" để đặt số |

## 3. LỖI TÌM RA HÔM NAY — ĐÃ VÁ NGAY (t5_25, verified sống)

| Lỗi | Vá |
|---|---|
| `super_admin_force_cancel_invoice_v2` dò nhầm schema bảng hoàn-tác → nhánh "đã hoàn sạch thì huỷ" **không bao giờ đạt** | Sửa probe → app_private; verify sống: tạo 50k → thu → hoàn hết → force-cancel **CANCELLED** ✅ |
| 7 RPC dính EXECUTE cho `anon` (3 meter, 2 RPC ngưỡng mới, recurring, utility — default PUBLIC của Postgres) | REVOKE anon+PUBLIC; `check-definer-acl` **xanh lại** ✅ |
| Hạng mục thanh lý sinh động bị **thiếu organization_id** (3 dòng mới sinh trong ngày) | `_termination_ensure_type` giờ resolve org từ membership + backfill → 0 dòng NULL ✅ |
| Residue test demo: 2 yêu cầu duyệt treo + 1 dòng lương paid=300k không có bút toán hiệu lực | REJECT 2 request, reset paid=0, huỷ voucher mồ côi ✅ |

## 4. P0 — ✅ ĐÃ LÀM HẾT 4/4 (2026-07-19/20, verified sống)

1. ✅ **Lỗ maker tự duyệt phiếu engine — VÁ (t5_26):** `assert_no_engine_request_v1`
   gắn vào `approve_voucher`/`unapprove_voucher`/`approve_income_expense_v1` →
   phiếu có approval_request PENDING/POSTED bị chặn 55000. Test sống: maker tự
   duyệt → CHẶN, unapprove POSTED → CHẶN, huỷ phiếu → request tự đóng (trigger a75).
2. ✅ **Màn "Chờ duyệt" — XONG (t5_26 backend + FE):** `list_my_pending_approvals_v1`
   + `decide_financial_request_v2` (tự map membership + CAS) + `withdraw_financial_
   request_v1`. FE: `src/pages/approvals/ApprovalsPage.tsx` + `useApprovals.ts` +
   route `/approvals` + menu "Chờ duyệt". Test backend PASS (inbox→decide→POSTED,
   withdraw→CANCELLED).
3. ✅ **Đồng bộ 2 hệ quyền + off-boarding — VÁ (t5_27):** trigger a80/a81 xoá/đổi
   staff_assignment ⇒ đóng role_binding (fail-closed) + bump authorization_version;
   `is_actor_offboarded_v1` gắn vào 3 hàm gác legacy ⇒ đình chỉ/thu hồi chặn cả
   đường cũ; `set_membership_status_v1` (chặn tự đổi + chặn hạ chủ-sở-hữu-cuối);
   `delete_staff_member` → off-boarding mềm (hết 23503). Test: suspend 30/2→0/0,
   phục hồi đúng, **10 người trước/sau 0 LỆCH**.
4. ✅ **Artifact prod → repo (DR) — XONG:** `scripts/authz-prepared/prod-snapshot/`
   PS01 engine duyệt · PS02 payment/invoice · PS03 storage shield · PS04 RBAC/org/
   meter/threshold · PS05 phần còn lại · README (thứ tự chạy lại từ DB trắng).

## 5. P1 — ✅ ĐÃ LÀM (2026-07-20)

- ✅ **Storage GHI chéo-org — VÁ (t5_29):** thêm 2 policy RESTRICTIVE UPDATE+DELETE
  dùng `can_read_storage_object_v1` (bucket non-PII luôn pass; 0/2448 object PII
  thiếu link nên không gãy xoá hợp lệ). Test: ketoan→false (chặn), super-admin→true.
- ✅ **NULL-org — VÁ (t5_30):** backfill từ cha (building/invoice/user/parent) +
  3 autofill trigger (public_room_events 1553→1004, notifications 76→6, invoice_
  audit_log dòng mới); material/inspection/salary/building_utility **sạch hết**.
  Còn cron_runs (log hệ thống) + building null-org / user đa-org = NULL hợp lệ.
- ✅ **2 phiếu demo trỏ sổ org thật — VÁ (t5_29):** reassign PT2607007/PT2607008
  sang sổ demo → **0 phiếu demo còn trỏ sổ org thật**.
- ✅ **`pay_utility_bill` né ngưỡng — VÁ (t5_28):** giờ đọc ngưỡng org; điện 2tr
  → tự duyệt, nước 8tr → Nháp. (`generate_recurring_vouchers` xác minh **đúng
  thiết kế** — chỉ tự duyệt khi template bật `repeat_auto_approve`.)
- ✅ **Emergency break-glass — XONG (t5_29):** wrapper `emergency_approve_request_v1`
  (map OWNER membership + version → inner fn). Test 3 guard: thiếu reauth→42501,
  reason<20→22023, maker tự-emergency→42501. Log qua `emergency_override_events`.
- ✅ **CI gates — XONG (`.github/workflows/ci-gates.yml`):** quality-gates
  (typecheck/lint/build/vitest, không cần secret, xanh ngay) + security-gates
  (definer-acl/view-invoker, bật khi có SUPABASE_PAT) + 3 job optional. Dùng
  preflight-job pattern (GitHub cấm `secrets.*` trong `if:` cấp job).
- ⏳ **R2 Worker bản hardened đã deploy chưa** — vẫn cần `wrangler deployments list`
  (không xác minh được read-only). CÒN LẠI duy nhất của P1.

## 6. P2 / đúng lộ trình (T7–T9, chưa tới hạn)

- **T7 drain — ĐÃ CHUẨN BỊ, CHƯA ÁP** (`scripts/authz-prepared/T7_PREPARED_drain_
  legacy_dml.sql`): rút DML trực tiếp 4 bảng tiền khỏi client. KHÔNG áp vì FE còn
  fallback → rút bây giờ sẽ gãy việc thật. File ghi rõ điều kiện go/no-go (≥1 chu
  kỳ vận hành 100% canonical + recovery set + owner duyệt) + Pha A (revoke anon,
  an toàn sớm) / Pha B (revoke authenticated, sau chu kỳ) + rollback khẩn.
- T9: retention 90 ngày + cleanup + audit độc lập cuối.
- RLS v2 shadow (T6b) chưa bắt đầu; route-inventory §6, matrix ngoài-tài-chính §7,
  5/8 edge function §15, suite bền vững §18 (persisted/perf/property) — cần đợt
  audit bổ sung riêng.
- Bulk payment RPC server-side, meter+invoice atomic, change_payment_method
  atomic, contract-create parity (form vẫn legacy), opening-adjust UI cutover.

## 7. VIỆC OWNER CẦN QUYẾT / TỰ LÀM NGAY TRÊN UI

1. Vào **Cài đặt → Thu chi → "Ngưỡng tự duyệt phiếu chi"** đặt con số (hiện chưa
   đặt = chi thường tự duyệt không giới hạn).
2. Gật/không gật: D3 phủ luôn nút huỷ hoá đơn thường?
3. Quyết số phận 2 phiếu demo trỏ sổ org thật (§5).
4. Duyệt thứ tự làm P0-1→P0-4 (tôi đề xuất làm P0-1+P0-2 thành một tranche
   "Approvals inbox", P0-4 làm song song vì thuần đóng gói file).
