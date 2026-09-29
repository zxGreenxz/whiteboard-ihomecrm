# Ghi chú thanh lý bắt buộc

**Mục tiêu:** Ghi nội dung đối chiếu ngay khi thanh lý và hiển thị lại trong chi tiết hợp đồng, khung hoàn khách, phiếu chi trả khách thanh lý.

**Thiết kế:** Ô “Nội dung thanh lý” bắt buộc cho hồ sơ mới; có câu mẫu bấm điền theo ba loại. Chọn loại không tự ghi đè nội dung. Nội dung được trim, lưu riêng tại hồ sơ trả phòng cho cả quyết toán ngay/sau và bỏ cọc, tham gia hash idempotency và không đổi khi quyết toán sau. Hồ sơ cũ giữ NULL, không tự bịa ghi chú. Ghi chú cũ và bảng quyết toán giữ nguyên.

**Phạm vi:** React/TypeScript, Zod và migration PostgreSQL additive; bảo toàn quyền đọc phiếu hiện có và logic tính tiền.

- [x] Test đỏ: chặn trống/whitespace, câu mẫu, lưu nội dung qua hai nhánh và đọc lại.
- [x] Sửa ContractReturnStep, TerminateDialog, contractExitCases.
- [x] Migration thêm return_note, validation backend và JSON đọc lại; kiểm replay, đổi nội dung cùng key, immutability, ACL và áp hai lần.
- [x] Hiển thị bổ sung trong ba modal qua nguồn đọc có quyền tương ứng; đưa panel vào vùng cuộn chi tiết hợp đồng mobile.
- [x] Test đơn vị, E2E headless, typecheck, build/bundle và review độc lập. Gate trước push được chạy lại sau thay đổi mobile.
- [x] Commit/push draft PR [#93](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/93), review độc lập trước tích hợp.
- [x] Áp hai migration production bằng forward lane, mỗi lần có backup đầy đủ và biên nhận catalog.

**Bằng chứng:** 121 test domain/UI/SQL và 16 test tích hợp chi tiết mobile đạt; E2E synthetic localhost 7/7, console sạch. Ba phép đột biến (bỏ bắt buộc nội dung, bỏ nội dung khỏi hash, bỏ ràng buộc tổ chức của facts) đều bị test bắt và khôi phục đúng digest. Hai migration chạy hai lần trong rollback trên TEST, sau đó được áp vào TEST. PostgREST với JWT tài khoản TEST trả 22023 cho ba dạng ghi chú rỗng, ghi chú hợp lệ đi qua khóa tổ chức tới kiểm tra hợp đồng không tồn tại, và đọc phiếu hoàn trả trường return_note. Không tạo/chỉnh dữ liệu nghiệp vụ khi kiểm API.

**Bằng chứng schema production ngày 29/09/2026:** Hai migration đã áp qua forward lane với backup đầy đủ (567 mục TABLE DATA mỗi bản). Lượt backup đầu của migration đọc phiếu bị ngắt SSL và đã dừng trước apply; lượt chạy lại thành công. Biên nhận nằm trong docs/generated/schema-change-evidence. Catalog và nội dung cả bốn function writer/reader khớp source đã review; ACL, owner, search_path và volatility đạt. PostgREST chặn bốn ca ghi chú rỗng/thiếu; ca ghi chú hợp lệ với hợp đồng không tồn tại trả lỗi sau khóa tổ chức và không tạo dữ liệu. Mười phiếu hoàn hiện có đọc được trường return_note, giữ NULL cho hồ sơ cũ. Hai gate đối chiếu tiền v1/v2 đạt.

**Concurrency TEST:** Hai session PostgreSQL với role authenticated xác nhận writer thứ hai chờ khóa transaction của writer thứ nhất. Replay cùng nội dung trả cùng hồ sơ; đổi nội dung cùng key bị chặn 23505. Sau rollback cả hai session, snapshot contract/room/cases/meter/pass/invoices/vouchers khớp digest cd7e5d851b3718dc5c8000916684ebd00ec2e2f5ae04da2b2713227a7e580da2.

**Tích hợp main:** Sau rebase với thay đổi theo dõi hoa hồng, giữ cả panel hoa hồng và thanh lý trong vùng cuộn mobile. Regression đã tái hiện cảnh báo React trùng key và xác nhận hết lỗi khi tách key theo loại panel. Bộ kiểm chứng liên quan đạt 205 test/13 suite, typecheck baseline 0, build và bundle đạt (565 chunk, entry 235 kB, tổng 8.82 MB, 99 trang lazy).

**Giới hạn kiểm chứng:** Chưa thử cuộc đua qua COMMIT hoặc concurrency nhánh quyết toán tiền (không đổi logic tiền). Browser ghi hồ sơ dùng phản hồi synthetic; production chỉ kiểm đọc và ca lỗi không phát sinh dữ liệu. Hồ sơ lịch sử thiếu nội dung giữ NULL, không backfill từ ghi chú sinh tự động. App chỉ promote sau CI đạt trên đúng SHA của main; tab đang mở bản cũ cần tải lại để gửi nội dung bắt buộc.
