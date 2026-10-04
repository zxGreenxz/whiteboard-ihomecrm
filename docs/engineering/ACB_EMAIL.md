# Nhận email ACB và gạch nợ hóa đơn

## Hành vi

Trong **Cài đặt → Gạch nợ tự động**, phần email ACB liên kết tài khoản ngân hàng
với một sổ nhận tiền và một Gmail. Người kết nối là người ủy quyền thu; hệ thống
kiểm lại quyền của người này mỗi lần xử lý giao dịch. Bản đầu hỗ trợ một Gmail
cho một tài khoản ACB, không tự chia một khoản chuyển vào nhiều hóa đơn.

Khi bật tự động, chỉ giao dịch mới từ mốc bật, xác minh được chữ ký ACB, có đúng
một mã hóa đơn và số tiền bằng khoản còn phải thu mới tự ghi nhận. Writer
`record_invoice_collection_v5` tạo thanh toán/phiếu thu và cập nhật công nợ cùng
một transaction. Mã nguồn giao dịch được giữ lại để thông báo Gmail lặp không
ghi thu thêm. Đảo thanh toán theo luồng thu hóa đơn hiện có, không xóa nguồn email.

Các ca thiếu mã hóa đơn, chuyển thiếu/thừa, ghi nợ, thông tin mâu thuẫn hoặc không
xác minh được người gửi nằm trong danh sách chờ. Người dùng có thể đối soát bằng
mã hóa đơn hoặc bỏ qua; ghi thu thủ công từ inbox vẫn phải qua chốt chữ ký,
tài khoản, CREDIT/VND, số tiền và quyền. Thư chưa xác minh không chứng minh đã
nhận tiền; kiểm tra tại ngân hàng trước khi xử lý bằng các nghiệp vụ khác.

Tiền giao dịch và số dư sau giao dịch là hai trường riêng. Email song ngữ chỉ là
một giao dịch. Để tự khớp, khách cần ghi nguyên mã hóa đơn trong nội dung chuyển
khoản; tên khách/phòng hoặc số tiền giống nhau không đủ để tự thu.

## Mẫu email

Parser ban đầu dựng theo ảnh ACB ngày 04/10/2026. Fixture trong Git dùng danh tính
và số tài khoản giả. Trước khi bật thực tế, cần kiểm chứng ít nhất một thư gốc
ghi có và, nếu dùng, một thư ghi nợ. Không commit thư ngân hàng thật.

Tải thư gốc bằng Gmail trên máy tính: mở thư → dấu ba chấm cạnh nút trả lời →
**Tải thư xuống**. File `.eml` giữ cấu trúc MIME và chữ ký DKIM, ảnh chụp không
giữ những thông tin này. Khi che/sửa nội dung thư, chữ ký không còn kiểm chứng
được; chỉ cung cấp file qua kênh riêng được người dùng đồng ý, không yêu cầu mật
khẩu Gmail. [Hướng dẫn Gmail](https://support.google.com/mail/answer/9261412).

## Nhận thư khi đóng ứng dụng

Worker chạy máy chủ dùng Gmail `watch` và Cloud Pub/Sub. Push chỉ mang hộp thư
và `historyId`; worker đọc lịch sử, tải thư rồi lưu kết quả. Gia hạn watch hằng
ngày, kiểm tra bù mỗi 5 phút và retry từ cursor đã lưu để bù thông báo bị trễ/mất.
Không lấy số tiền từ payload webhook.

Gmail thường phát push trong vài giây sau thay đổi hộp thư, nhưng vẫn có thể
chậm/mất và ACB có thể gửi thư trễ. Đây là gần thời gian thực **sau khi thư tới
Gmail**, không cam kết tức thì từ thời điểm ngân hàng ghi có.
[Tài liệu Google](https://developers.google.com/workspace/gmail/api/guides/push).

## Điều kiện kích hoạt

Mã nguồn và migration được giao qua draft PR; việc có code không có nghĩa kết
nối Gmail, Pub/Sub hoặc tự thu production đã được bật.

1. Kiểm thử/review tiền, phân quyền, đồng thời và rollback nguồn trên TEST theo
   [Project Contract](PROJECT_CONTRACT.md); áp migration production chỉ qua lane
   backup/review. Kiểm RPC/ACL/realtime sau apply.
2. Triển khai [worker](../../services/bank-email-worker/README.md), cấu hình OAuth
   web client, callback HTTPS, Gmail API và Pub/Sub authenticated push. Quyền
   `gmail.readonly` cho phép đọc toàn hộp thư; ứng dụng chỉ lưu trường cần cho ACB.
   Xử lý consent/verification và giới hạn chế độ thử theo cấu hình Google Cloud.
3. Cấu hình server secrets và khóa mã hóa riêng. App Vercel dùng
   `BANK_EMAIL_WORKER_URL=https://<worker-host>` và `APP_ORIGIN` đúng origin của
   app; frontend đặt `VITE_BANK_EMAIL_WORKER_URL=/api/bank-email`. Bridge cùng
   origin giữ CSP hiện có, chỉ chuyển user JWT tới worker đã cấu hình, không đi
   theo redirect của upstream. Không dùng secret trong VITE, không chép vault vào repo.
4. Người có quyền chọn đúng sổ/tài khoản, tự đăng nhập Google để cấp quyền. Xác
   minh thư ACB thật và thử khoản nhỏ trên TEST trước khi bật tự ghi production.
5. Kiểm nhận thông báo khi đóng trang, retry webhook, mất token và thu hồi quyền.
   Ngắt kết nối phải dừng tự thu ngay; worker thu hồi grant rồi xóa token mã hóa.
   Chủ kết nối vẫn có thể ngắt Gmail tại trang **Tài khoản** sau khi bị thu hồi
   quyền nghiệp vụ; trang này chỉ hiện trạng thái kết nối của chính người đó.
   Thông báo đẩy ngoài trang còn phụ thuộc quyền nhận thông báo trên thiết bị và
   hạ tầng push hiện có; việc ghi giao dịch phía máy chủ không phụ thuộc trang đang mở.

Chi tiết contract: [API](../superpowers/specs/2026-10-05-acb-email-api.md),
[thiết kế](../superpowers/specs/2026-10-05-acb-email-design.md).
