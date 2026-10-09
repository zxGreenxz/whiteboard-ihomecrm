# Biến động số dư

Trang `/bien-dong-so-du` là hộp tiếp nhận toàn hệ thống dành riêng cho **super admin**. Chủ công ty, Admin của công ty và kế toán chưa được mở trang này. Quyền được kiểm bằng `is_super_admin()` phía máy chủ; bộ chọn công ty không giới hạn trang tổng.

## Các màn hình

- **Tin nhận được:** lọc theo nguồn, loại tin (SMS, thông báo app, email, tin thử), mã sự kiện và thời điểm máy chủ nhận. Ngày lọc dùng giờ Việt Nam. Mỗi trang tối đa 25 tin. Mỗi dòng hiện **số tiền vào (+) hoặc ra (−), nội dung chuyển khoản, ngân hàng, 4 số cuối tài khoản và số dư** do máy chủ tách từ tin; tin không phải biến động (OTP, quảng cáo) ghi "Không phải tin biến động số dư". Bấm một dòng mới tải nội dung nguyên văn.
- **Nguồn kết nối:** tạo nguồn loại **Điện thoại Android** hoặc **Gmail**, cấp lại khóa, tạm dừng hoặc thu hồi. Khóa chỉ hiện sau lần tạo/cấp lại; với điện thoại thì sao chép vào iHome Gateway, với Gmail thì nằm sẵn trong script phải dán trước khi đóng. Khóa cũ mất hiệu lực khi cấp lại; thu hồi là vĩnh viễn, không xóa tin đã nhận.
- **Vận hành:** trạng thái tiếp nhận, địa chỉ nhận đã cấu hình, hướng dẫn kết nối Gmail.

Khi trang đang được xem, danh sách ở trang đầu cùng thông tin nguồn và vận hành tự cập nhật mỗi 15 giây; các trang tin cũ và nội dung chi tiết không được tải lại định kỳ.

## Kết nối điện thoại

1. Bấm **Tải app Android** ở đầu trang để tải APK iHome Gateway (bản release đã ký) rồi cài trên điện thoại Android 8 trở lên.
2. Mở **Nguồn kết nối → Thêm nguồn**, chọn **Điện thoại Android**, nhập tên dễ nhận diện.
3. Sao chép địa chỉ webhook và khóa một lần vào iHome Gateway. Nếu chưa thấy địa chỉ webhook được xác nhận, hoàn tất cấu hình máy chủ trước.
4. Chọn SMS hoặc các ứng dụng được phép chuyển thông báo; cấp quyền trên Android và bật chuyển tiếp. Phần lớn ngân hàng báo biến động bằng thông báo của app ngân hàng, nên cần bật **chuyển thông báo** và chọn app ngân hàng, không chỉ SMS.
5. Gửi tin thử, làm mới trang tổng và mở chi tiết để xác nhận nguồn nhận đúng. Tin thử được ghi rõ là dữ liệu giả lập.

## Kết nối Gmail

Gmail được nối bằng **Google Apps Script chạy trong chính tài khoản Google nhận email ngân hàng**. CRM không giữ mật khẩu Gmail hay mật khẩu ứng dụng; script chỉ mang khóa nguồn như điện thoại.

1. **Nguồn kết nối → Thêm nguồn**, chọn **Gmail**, đặt tên.
2. Trong hộp thoại hiện ra, chọn lấy **email từ các ngân hàng** (tên miền ngân hàng phổ biến) và/hoặc **nhãn Gmail tự gắn** (tạo bộ lọc Gmail gắn nhãn cho thư muốn chuyển). Bấm **Sao chép script**.
3. Mở script.google.com bằng đúng tài khoản Gmail đó → **Dự án mới**, xoá mã mẫu, dán script, **Lưu**.
4. Chọn hàm `caiDat` → **Chạy** → cấp quyền (Nâng cao → Đi tới dự án → Cho phép; đây là script của chính chủ tài khoản). Google mô tả quyền là "đọc, soạn, gửi và xoá email" vì dịch vụ `GmailApp` chỉ có một mức quyền đầy đủ; script chỉ đọc thư và gửi email ngân hàng về CRM.
5. Trong vài phút nguồn hiện "Gmail · script đã kết nối" kèm nhịp quét và số phút đã dùng trong ngày.

Nhịp quét: ban ngày **1 phút/lần**, **00:30–06:30 là 10 phút/lần** (hẹn giờ quay lại 1 phút đúng 06:30). Tài khoản Google thường chỉ được chạy script tự động **90 phút/ngày cho mọi script của tài khoản** (gói Google One/Gemini không nâng hạn mức này; chỉ Google Workspace mới được 6 giờ). Khi script này đã dùng khoảng 60 phút trong ngày, nó tự giãn **5 phút/lần** tới hết ngày; script khác trong cùng tài khoản cũng ăn vào 90 phút đó. Khóa bị tạm dừng/thu hồi (CRM trả 401/403) thì script giãn **30 phút/lần**, ném lỗi để Google gửi mail báo chủ, và tự quay lại nhịp thường khi khóa dùng lại được.

Cách script không làm mất hoặc gửi trùng thư:

- Lần đầu chạy lấy thư của 24 giờ trước. Mỗi lượt lật hết các trang kết quả Gmail (50 luồng/trang), gửi thư cũ trước, dừng sau 4 phút (Google cắt cứng ở 6 phút) và lưu tiến độ giữa chừng; lượt sau gửi tiếp.
- Con trỏ chỉ tiến tới thư cuối đã gửi xong; CRM lỗi tạm thời (5xx) thì lượt sau gửi bù. Thư có giờ gửi sớm hơn giờ tới hộp thư tối đa 6 giờ vẫn được lấy.
- Danh sách thư đã gửi chỉ giữ thư còn trong cửa sổ quét, chia 5 ô nhớ (mỗi ô Google cho 9 KB).
- CRM trả 400 (lệch định dạng) thì script dừng và báo lỗi, không bỏ qua thư. 409 thì script gửi thử một tin báo sống: báo sống được nghĩa là thư đó đã lưu từ trước (bỏ qua); không được nghĩa là khóa đang gắn với bản script khác (dừng và hướng dẫn cấp lại khóa).

Gỡ: chạy hàm `goCaiDat` trong Apps Script (giữ mã thiết bị để cài lại trong cùng dự án) và **Thu hồi** nguồn trên CRM. **Cấp lại khóa** nguồn Gmail đồng thời gỡ gắn bản script cũ: dán script mới vào đúng dự án đang chạy rồi chạy lại `caiDat`; nếu dán vào dự án mới thì chạy `goCaiDat` ở dự án cũ để không tốn hạn mức. Thẻ nguồn Gmail báo khi hơn 30 phút không nhận tin từ script. Script chứa khóa: không chia sẻ.

## Tách số tiền

Máy chủ (`bank-event-admin`) giải mã từng tin của trang danh sách và tách chiều tiền, số tiền, số dư, 4 số cuối tài khoản, nội dung và thời điểm theo mẫu chung của tin ngân hàng Việt Nam (`supabase/functions/_shared/bank-events-parse.ts`). Bộ tách chạy lúc đọc nên sửa bộ tách là áp dụng cho cả tin cũ. Bộ tách chỉ đọc 3.000 ký tự đầu của tin; khi tin vừa có từ khoá tiền vào vừa tiền ra mà không có dấu +/− thì để trống chiều tiền thay vì đoán. Mẫu lạ có thể tách sai hoặc không tách được: đối chiếu với nội dung nguyên văn ở chi tiết. Đây chỉ là hiển thị để theo dõi, chưa dùng để xác nhận thanh toán hay ghi sổ.

## Giới hạn và dữ liệu nhạy cảm

SMS có thể bao gồm OTP và tin cá nhân. Danh sách chỉ nhận phần đã tách (số tiền, số dư, nội dung chuyển khoản, 4 số cuối tài khoản), không nhận nội dung nguyên văn; bản mã không rời Edge. Mỗi lần xem danh sách có tóm tắt được ghi dấu vết đọc kèm bộ lọc/trang và số tin; cùng người, cùng bộ lọc chỉ ghi một lần mỗi 10 phút (danh sách tự làm mới 15 giây/lần). Mở chi tiết ghi dấu vết từng lần. Chỉ mở chi tiết qua API đã xác thực. Khóa cấp nguồn và script Gmail nằm trong bộ nhớ màn hình trong thời gian hộp thoại mở, không lưu vào localStorage hoặc cache mutation. Đổi tài khoản hoặc rời trang phải bỏ dữ liệu cũ; các query có mã người dùng trong khóa cache.

Khóa của nguồn điện thoại không gửi được email và khóa của nguồn Gmail không gửi được SMS/thông báo; máy chủ từ chối (403) loại tin không đúng loại nguồn.

Nguồn giữ dấu vết thiết bị và công ty nếu đã được xác minh để có thể phân quyền tổ chức sau. Giai đoạn này chưa cấp ACL nhân viên, chưa tự gắn tin chưa phân loại vào công ty đang chọn, chưa tự hạch toán, xác nhận thanh toán hoặc cộng tin nhắn thành doanh thu/số dư. Tìm kiếm chỉ dựa trên tên nguồn/mã sự kiện, không tìm trong nội dung mã hóa. Android hoặc ngân hàng có thể ẩn nội dung thông báo; không phải ngân hàng nào cũng gửi email cho từng giao dịch.

## Nguồn triển khai và kiểm chứng

- Giao diện: `src/pages/bank-events/BankEventsPage.tsx`, hộp kết nối Gmail `src/pages/bank-events/GmailSetup.tsx`. Nút tải trỏ tới APK ở GitHub Release theo hằng `gatewayApk`; phát hành bản mới thì đăng release từ artifact ký của CI rồi đổi hằng này.
- Script Gmail: `src/lib/bank-events/gmailScript.ts`; test Deno `supabase/functions/bank-event-ingest/gmail-script.test.ts` chạy đúng script trên Google giả lập rồi đưa tin qua handler nhận thật.
- Service/validation: `src/lib/bank-events/service.ts`; truy vấn theo tài khoản: `src/hooks/bank-events/useBankEvents.ts`.
- Guard: `src/components/auth/RequireSuperAdmin.tsx`; navigation dùng `superAdminOnly` trong capability registry.
- API quản trị: `bank-event-admin`; API kiểm lại JWT và tier super admin ở mỗi yêu cầu.
- SQL: `20261009042140_bank_event_raw_inbox.sql` và `20261009103855_bank_event_gmail_nguon_va_tom_tat.sql` (loại nguồn, loại tin email, bản mã cho tóm tắt); test PGlite `scripts/__tests__/bank-event-*-sql.test.mjs`.
- Test trình duyệt fixture: `.e2e-fleet/specs/bank-events.spec.ts`. Fixture chỉ dùng dữ liệu giả; kiểm này không thay bằng chứng JWT/RLS thật, nhận SMS từ thiết bị hay chạy Apps Script thật.

Khi API báo chưa xác định kết quả ghi, tải lại danh sách trước khi thử lại. Nếu nguồn đã tạo nhưng khóa chưa được giữ, dùng **Cấp lại khóa**; không thử tạo thêm nguồn một cách tự động.
