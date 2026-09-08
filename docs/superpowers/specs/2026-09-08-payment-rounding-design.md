# Tiền thối thực tế và thống kê khoản bỏ qua

Yêu cầu ngày 08/09/2026: sửa được tiền thối ở cả keypad, form Thu tiền và Hóa đơn; khoản thiếu thực tế dưới 10.000đ được tính đóng đủ, lưu dấu và xem theo kỳ hóa đơn/người thu.

## Nghiệp vụ đã chốt theo yêu cầu

- Tiền thối mặc định bằng phần dư, có thể nhập số thực thối bằng đồng ở cả hai giao diện mobile. Khi thay đổi số khách trả hoặc phương thức, trả về gợi ý tiền thối mới để không giữ giá trị của tình huống cũ.
- Thực thu = tổng khách đưa − tiền thực thối. Khoản thiếu = còn phải thu trước giao dịch − thực thu. Với 0 < thiếu < 10.000đ và không thiếu tiền cọc, ghi rounding và đánh dấu PAID. Thiếu đúng 10.000đ trở lên vẫn là công nợ. Không biến rounding thành tiền mặt/doanh thu đã nhận.
- Chỉ thối từ TM, không vượt TM của giao dịch hoặc làm thực thu bằng/nhỏ hơn 0. Không được thối ít hơn phần dư rồi âm thầm giữ tiền khách; dùng lựa chọn credit hiện có nếu cần giữ phần dư. Credit vẫn phải đúng phần dư, không kết hợp thối tùy chỉnh.
- Đồng bộ preview, payload, server, thu từng hóa đơn, hàng loạt và Thu tiền. Trường hợp hóa đơn 4.805.000đ, đưa 5.000.000đ, thối 200.000đ: thực thu 4.800.000đ, bỏ qua 5.000đ, PAID.

## Lưu trữ và báo cáo

Tái sử dụng số rounding đã lưu trong collection/payment làm nguồn tiền duy nhất; bổ sung metadata nguyên nhân nếu cần, không tạo một sổ tiền song song có thể lệch. Ghi nhận nguyên tử cùng giao dịch, người thu lấy từ actor máy chủ. Bản cũ vẫn xem được từ rounding lịch sử; không suy đoán khoản bỏ qua từ số dư của mọi hóa đơn.

Thêm mục “Khoản bỏ qua” trong báo cáo Thu tiền, có thể mở từ Hóa đơn. Chọn kỳ hóa đơn, người thu và tòa; hiện tổng tiền, số hóa đơn, nhóm theo người thu và danh sách chi tiết (tòa/phòng/hóa đơn/kỳ/ngày thu/người thu/khách đưa/thực thối/thực thu/bỏ qua/lý do). Phân loại “Khách đóng thiếu”, “Thối thêm”, “Dữ liệu cũ” nếu không đủ dấu vết. Loại giao dịch hoàn tác/hủy khỏi tổng, vẫn giữ lịch sử gốc. Tổng tính phía SQL, danh sách phân trang; cùng quyền báo cáo Thu tiền và phạm vi tổ chức/tòa.

## Tương thích và xác minh

Giữ chữ ký RPC V5 để client cũ hoạt động; tender JSON có thể mang requested_change_amount cho từng dòng TM. Nếu không có trường này, server tính đúng hành vi cũ. Có trường này thì kiểm đủ số tiền hợp lệ, phân bổ cân bằng, idempotency theo cả payload, khóa hóa đơn và kiểm expected_paid_amount như cũ. Không nới ACL, writer guard, đóng sổ, cọc hoặc reversal.

Kiểm ngưỡng 0/1/9.999/10.000; tiền hỗn hợp TM/TK/TT; credit; tiền cọc; thiếu sổ; retry trùng/đổi payload; đồng thời; hoàn tác; cross-org/tòa; tổng báo cáo và phân trang. SQL harness chỉ DEMO và tự rollback. Kiểm UI headless DEMO, typecheck, test, build/bundle, mutation, hai reconcile và các gate của migration/tiền. Mở draft PR cho thay đổi tiền theo AGENTS.md.
