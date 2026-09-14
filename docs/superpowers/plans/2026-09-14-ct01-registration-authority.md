# CT01 Registration Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dòng “Kính gửi” lấy phần địa chỉ từ Phường/Xã/Thị trấn/Đặc khu đến hết tỉnh hoặc thành phố trong “Địa chỉ chi tiết” của tòa nhà.

**Architecture:** Tái sử dụng dữ liệu `street_address` đã được chuẩn hóa trong `buildCT01Data`. Tách hậu tố hành chính một lần rồi dùng cho `registration_authority`; khi không tìm thấy thì dùng `ward` hiện có.

**Tech Stack:** TypeScript, Vitest, Playwright, Docxtemplater.

## Global Constraints

- Không thay đổi mẫu hợp đồng hoặc file DOCX trong hạng mục này.
- Địa chỉ tòa nhà trong CT01 và hợp đồng vẫn là nguyên `street_address.trim()`.
- Phần dự phòng vẫn dùng trường `ward` để các hồ sơ cũ tải được.

---

### Task 1: Nguồn địa chỉ cho Kính gửi

**Files:**
- Modify: `src/lib/ct01Document.ts`
- Test: `src/lib/__tests__/ct01Document.test.ts`
- Test: `.e2e-fleet/specs/ct01-download.spec.ts`

**Interfaces:**
- Consumes: `buildCT01Data(customer, building, lease, now)` và `building.street_address`.
- Produces: `registration_authority` chứa toàn bộ hậu tố hành chính trong địa chỉ chi tiết.

- [ ] **Step 1: Viết kiểm thử thất bại**

Thêm địa chỉ `111/46F Phạm Văn Chiêu, Phường An Hội Tây, TP Hồ Chí Minh`, giữ `ward: 'Phường 14'` và mong đợi `registration_authority: 'Công an Phường An Hội Tây, TP Hồ Chí Minh'`.

- [ ] **Step 2: Chạy kiểm thử để xác nhận RED**

Run: `npm test -- --run src/lib/__tests__/ct01Document.test.ts`
Expected: FAIL vì hiện tại trả về `Công an Phường 14`.

- [ ] **Step 3: Sửa tối thiểu hàm dựng dữ liệu**

Trong `buildCT01Data`, tìm vị trí bắt đầu của thành phần có tiền tố hành chính trong các phần phân cách bằng dấu phẩy, nối các phần từ vị trí đó đến hết và dùng kết quả cho `registration_authority`. Nếu không tìm thấy thì dùng `ward` đã chuẩn hóa.

- [ ] **Step 4: Chạy kiểm thử GREEN và kiểm tra luồng tải Word**

Run: `npm test -- --run src/lib/__tests__/ct01Document.test.ts`
Expected: toàn bộ unit test PASS.

Run: `cd .e2e-fleet && npx playwright test specs/ct01-download.spec.ts`
Expected: toàn bộ E2E PASS, không có lỗi console hoặc page error.

- [ ] **Step 5: Kiểm tra và phát hành**

Chạy typecheck, lint các file sửa, gate trước push, build và bundle. Commit đúng các file liên quan, đẩy lên `main`, xác minh CI của exact SHA rồi promote sang production theo Project Contract §3.
