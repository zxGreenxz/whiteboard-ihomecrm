# Báo chi nhanh — gửi giọng nói và ảnh kèm nội dung

**Yêu cầu:** Dừng ghi âm thì chép lời và tự gửi để lập thẻ nháp. Thêm nút ảnh kèm nội dung ngoài cùng bên trái camera/thư viện hiện tại; chọn ảnh rồi nhập chữ hoặc nói để gửi chung một lượt.

**Thiết kế:** Composer giữ một ảnh chờ gửi, cho xem/bỏ/đổi ảnh. Mic luôn dùng được khi đã có chữ. Nói xong ghép với chữ đang có rồi gửi một lần, kèm ảnh nếu có; nhận dạng lỗi/rỗng giữ bản soạn. Khoá thao tác trong lúc nhận dạng để tránh gửi trùng hoặc đổi đích. Rời trang bỏ kết quả nhận dạng muộn. Nút camera/thư viện cũ tiếp tục gửi ảnh trực tiếp khi không có ảnh chờ. Lưu chứng từ vẫn qua thẻ nháp hiện có.

**Phạm vi:** UI và dữ liệu đầu vào AI; không đổi phép tính tiền, quyền, schema hay thao tác ghi sổ. Một file ảnh mỗi lượt như API hiện tại. Không đổi prompt vì đã nhận cả chữ và ảnh trong cùng message.

**Thực hiện trong phiên này:**
- [x] Sửa test composer: voice tự gửi; ảnh chờ + chữ/voice; huỷ/bỏ ảnh; lỗi/rỗng; chống gửi trùng; bỏ kết quả muộn.
- [x] Sửa `QuickEntryComposer.tsx`: giữ ảnh chờ và URL preview có cleanup, thêm nút Paperclip, giữ mic khi đã có chữ, submit chung và khoá lúc bận.
- [x] Sửa `useQuickEntryFeed.submitPhoto(file, mode, text?)` gửi text vào `askAi` và lưu trong tin ảnh; `QuickEntryPage` truyền và hiển thị caption, reset composer khi đổi user/org.
- [x] Chạy test liên quan; Playwright headless luồng thật trong browser với AI/dữ liệu nền giả lập, kiểm mobile/desktop và console.
- [x] Build + bundle, stage file cụ thể, chạy gate trước push, review diff cuối. Commit/push theo Project Contract §3; ghi rõ các phần chưa xác minh.

**Ca kiểm độc lập:** chữ '102LVT sửa điện' + voice 'ba trăm nghìn' + ảnh bill phải thành đúng một lượt đọc AI có cả hai phần. Không tự lưu phiếu. Nhận dạng lỗi không làm mất ảnh/chữ; dừng ghi hai lần không gửi đôi. Mic không bị thay bằng nút gửi khi có caption.

**Biên nhận 04/10/2026:** 718 test / 25 file đạt; 3 browser tests đạt (320/375/1280 px, không lỗi console/tràn ngang). Thêm 2 E2E trên local build với tài khoản DEMO chủ nhà/quản lý thật, quyền và dữ liệu nền thật, AI transport có kiểm JWT/org được mô phỏng; không lưu phiếu, dọn nháp cuối ca. Build/bundle đạt (613 chunks, entry 239 kB, 101 trang lazy). Review độc lập không có phát hiện cần sửa. Chưa kiểm micro/Safari trên iPhone thật và chất lượng phản hồi AI trực tiếp.

Gate trước push: 46/46 đạt, gồm typecheck baseline, strict islands, lint và kiểm rò tổ chức; types live sau normalize không có drift. `reconcile-money` đạt với 1.216 phiếu qua 2 trang; `reconcile-money-v2` đạt trên 21 sổ thực và 3.887 dòng posting. Invariant/idempotency/concurrency hiện có được kiểm trong suite quick-entry; không đổi invariant tiền. Review harness bổ sung đã yêu cầu chặn RPC ghi phiếu/upload trước mạng, thay vì chỉ đếm request bảng; đã bổ sung interceptor tương ứng.
