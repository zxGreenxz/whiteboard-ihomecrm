# Thiết kế điều chỉnh hóa đơn đã thu và kiểm tra

## Mục tiêu

Cho phép người có quyền điều chỉnh hóa đơn đã phát hành/đã thu bằng cụm dòng mới trong cùng hóa đơn, giữ nguyên snapshot trước điều chỉnh, ghi nhận chênh lệch tiền ngay khi lưu và tách riêng trạng thái kiểm tra.

## Quy tắc nghiệp vụ

- Dòng gốc bất biến, hiển thị màu xám; cụm dòng điều chỉnh hiển thị ngay bên dưới.
- Server tự tính tổng từ các dòng, không tin subtotal/total/chênh lệch do client gửi.
- Chênh lệch dương so với số đã thu trở thành công nợ của hợp đồng; chênh lệch âm tạo customer credit để FIFO cấn trừ hóa đơn sau.
- Điều chỉnh lặp lại dùng cùng một bản ghi điều chỉnh đang mở hoặc tạo revision mới có liên kết; không tạo credit/nợ trùng.
- Trạng thái thanh toán giữ độc lập với `adjustment_review_status` (`NONE`, `PENDING`, `CHECKED`).
- Chỉ người có capability kiểm tra mới gọi RPC xác nhận; RPC ghi actor/time và không thay đổi tiền.

## An toàn

RPC điều chỉnh khóa hóa đơn và các liên kết thanh toán trong một transaction, kiểm tra organization/building/capability, trạng thái hợp lệ, payment/refund/credit application, revision token và idempotency key. RLS và ACL chặn DML trực tiếp vào snapshot/audit; lịch sử append-only. Khi khoản nợ đã được carry sang hóa đơn sau, RPC tạo một nguồn nợ duy nhất và loại trừ nguồn cũ khỏi tính lại để tránh double-count.

## Hiển thị

Danh sách có bộ lọc Chưa kiểm tra/Đã kiểm tra; chi tiết hiển thị before/after, lý do, người điều chỉnh/thời gian và người kiểm tra/thời gian. Nút xác nhận chỉ hiện với quyền kiểm tra.

## Kiểm thử

Kiểm server cho quyền, cross-org/building, concurrent revision, idempotency, paid/refunded/credit-applied, carry-over không trùng, rounding và review-only. UI test kiểm hiển thị dòng xám, chênh lệch, bộ lọc và quyền nút.
