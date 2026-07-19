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

## 4. CẦN BỔ SUNG — P0 (làm trước chu kỳ lương/lợi nhuận/chi-lớn kế tiếp)

1. **Lỗ maker tự duyệt phiếu engine (CONFIRMED, không chủ-đích):** 19/19 phiếu
   lương/LN do engine tạo KHÔNG được nhận vào flow-ownership → không bị freeze →
   nút Duyệt cũ (`approve_voucher`, nhánh "người tạo") cho phép **maker tự duyệt
   phiếu đang chờ engine**; UI còn tự rơi vào đúng đường đó. Vá: claim ownership
   trong 3 writer engine + backfill 19 phiếu, hoặc guard mọi đường duyệt từ chối
   phiếu có approval_request mở. **Phải đi kèm mục 2** (nếu chặn mà chưa có UI
   duyệt engine thì phiếu lương kẹt).
2. **Chưa có màn hình DUYỆT engine trong sản phẩm:** decide chỉ gọi được bằng
   SQL admin. Cần: RPC wrapper decide (authorize + map membership) + trang
   "Chờ duyệt" (Approvals inbox) + withdraw/tự-đóng request khi phiếu bị huỷ.
3. **Hai hệ quyền không có cầu đồng bộ + off-boarding gãy:** UI sửa quyền chỉ ghi
   hệ cũ (staff_assignments) — gỡ quyền trên UI KHÔNG thu hồi hệ mới
   (role_bindings); nút xoá nhân viên đang gãy (FK RESTRICT 23503). Cần admin RPC
   dual-write + suspend/revoke + job đối chiếu định kỳ (đang lệch 112 key).
4. **Chốt artifact prod → repo (disaster-recovery!):** engine duyệt v2, payment
   v4, lá chắn storage (`storage_object_links` + policy RESTRICTIVE), RBAC t2_*,
   org t6a_*, 3 RPC meter — đang sống ở DB nhưng **không có file nào trên main**.
   Khôi phục từ migrations hiện tại sẽ MẤT các lớp này.

## 5. P1 (sớm, không khẩn)

- **Storage policies GHI** còn bucket-wide (đọc đã cách ly org, nhưng ghi đè/xoá
  chéo org về lý thuyết vẫn được) → nối storage_object_links sang INSERT/UPDATE/DELETE.
- **NULL-org sinh mới hằng ngày** ở 14 bảng phụ (invoice_audit_log,
  public_room_events, notifications…) → autofill/DEFAULT + backfill đợt.
- 2 phiếu demo đang trỏ **sổ quỹ của org thật** (PT2607007/PT2607008 — nghi fixture
  cũ): owner quyết reassign hay huỷ, xong mới thêm FK same-org.
- `pay_utility_bill` + `generate_recurring_vouchers_v2` chưa đọc cờ/ngưỡng
  (recurring đã bị revoke anon ở t5_25).
- Emergency break-glass (`emergency_approve_financial_v1`) chưa có endpoint + alert.
- CI gates (typecheck/definer-acl/view-invoker/vitest/cross-tenant) chưa có
  workflow tự động; alert + audit pipeline trống.
- R2 Worker bản hardened đã deploy chưa — không xác minh được bằng read-only
  (cần `wrangler deployments list`).

## 6. P2 / đúng lộ trình (T7–T9, chưa tới hạn)

- T7 drain: thu hồi direct DML 4 bảng tiền khỏi client (đang mở chủ-đích
  coexistence), gỡ fallback FE, revoke v2/v3 legacy.
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
