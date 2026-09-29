# Ghi chú thanh lý bắt buộc

**Mục tiêu:** Ghi nội dung đối chiếu ngay khi thanh lý và hiển thị lại trong chi tiết hợp đồng, khung hoàn khách, phiếu chi trả khách thanh lý.

**Thiết kế:** Ô “Nội dung thanh lý” bắt buộc cho hồ sơ mới; có câu mẫu bấm điền theo ba loại. Chọn loại không tự ghi đè nội dung. Nội dung được trim, lưu riêng tại hồ sơ trả phòng cho cả quyết toán ngay/sau và bỏ cọc, tham gia hash idempotency và không đổi khi quyết toán sau. Hồ sơ cũ giữ NULL, không tự bịa ghi chú. Ghi chú cũ và bảng quyết toán giữ nguyên.

**Phạm vi:** React/TypeScript, Zod và migration PostgreSQL additive; bảo toàn quyền đọc phiếu hiện có và logic tính tiền.

- [x] Test đỏ: chặn trống/whitespace, câu mẫu, lưu nội dung qua hai nhánh và đọc lại.
- [x] Sửa ContractReturnStep, TerminateDialog, contractExitCases.
- [x] Migration thêm return_note, validation backend và JSON đọc lại; kiểm replay, đổi nội dung cùng key, immutability, ACL và áp hai lần.
- [x] Hiển thị bổ sung trong ba modal qua nguồn đọc có quyền tương ứng; đưa panel vào vùng cuộn chi tiết hợp đồng mobile.
- [x] Test đơn vị, E2E headless, typecheck, build/bundle và review độc lập. Gate trước push được chạy lại sau thay đổi mobile.
- [ ] Commit/push draft PR; không phát hành khi bằng chứng schema/gate chưa đủ.

**Bằng chứng:** 121 test domain/UI/SQL và 16 test tích hợp chi tiết mobile đạt; E2E synthetic localhost 7/7, console sạch. Ba phép đột biến (bỏ bắt buộc nội dung, bỏ nội dung khỏi hash, bỏ ràng buộc tổ chức của facts) đều bị test bắt và khôi phục đúng digest. Hai migration chạy hai lần trong rollback trên TEST, sau đó được áp vào TEST. PostgREST với JWT tài khoản TEST trả 22023 cho ba dạng ghi chú rỗng, ghi chú hợp lệ đi qua khóa tổ chức tới kiểm tra hợp đồng không tồn tại, và đọc phiếu hoàn trả trường return_note. Không tạo/chỉnh dữ liệu nghiệp vụ khi kiểm API.

**Giới hạn phát hành:** Chưa áp hai migration hoặc phát hành app lên production. Generated types và RPC surface từ gate vẫn mô tả production hiện tại; cần sinh lại sau rollout schema. Kiểm browser dùng phản hồi synthetic, chưa xác minh thao tác tạo hồ sơ mới và lưu ghi chú trên dữ liệu thật qua browser. Hồ sơ lịch sử thiếu nội dung giữ NULL; không backfill từ ghi chú sinh tự động.
