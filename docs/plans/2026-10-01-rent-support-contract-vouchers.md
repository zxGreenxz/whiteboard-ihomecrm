# Khấu trừ vào phiếu của hợp đồng

Thiết kế đã được người dùng duyệt: bỏ chọn/xác minh người nhận ở form hợp đồng.
Lịch hỗ trợ lưu người chịu (tòa/Sale) và nguồn trừ; mặc định hoa hồng, hoặc thưởng
trước rồi hoa hồng. Khấu trừ toàn bộ cam kết lúc lập phiếu sau ký. Thông tin người
nhận dùng từ phiếu, không bắt đăng ký danh tính riêng.

## Thực hiện

1. Cho phép lịch Sale mới có `sale_party_id=null` (nguồn là phiếu của hợp đồng).
   Giữ ràng buộc danh tính của lịch cũ đã có ID; không sửa lịch hay số tiền đã ghi.
   Quote, execute và guard chỉ nhận nguồn canonical cùng tổ chức/hợp đồng/loại.
2. Bỏ UI xác minh ở form hợp đồng. Ở phiếu mới, nhận tên/ngân hàng hoặc quản lý
   theo form thông thường; liên kết nội bộ từ thông tin đó khi xem khoản thực nhận.
   Dùng lại khóa yêu cầu khi mất phản hồi, không đăng ký hoặc trừ lặp.
3. Kiểm draft → mở lại → ký, trừ hoa hồng và thưởng trước, tòa chịu, thiếu nguồn,
   mất phản hồi/tạo lại, quyền và chống chéo hợp đồng. Review độc lập diff cuối.
4. Chạy gate đúng phạm vi, draft PR, migration forward có backup và promote đúng SHA.

Không suy lỗi từ các hợp đồng cũ thiếu phiếu; giữ theo dõi yêu cầu tạo đã thực sự
phát sinh và nút tạo lại hiện có. Hóa đơn khách vẫn giảm đúng từng kỳ theo lịch.

## Kiểm chứng trước phát hành

- Unit/UI/SQL: lịch mới không cần người nhận; draft giữ đủ cấu hình; tính tổng và
  phân bổ đủ một lần; giữ ràng buộc lịch cũ; chặn chứng từ thay đổi trong lúc xác nhận.
- TEST qua JWT thật: hai chính sách 1,8 triệu, tòa chịu, thiếu nguồn, mất phản hồi,
  hai người tạo đồng thời, nguồn của hợp đồng khác và vai không được phép.
- Trình duyệt headless vào app TEST: nhập tên người nhận trên phiếu → xem 3 triệu
  trừ 1,8 triệu còn 1,2 triệu → tạo phiếu; không có lỗi console. Fixture đã dọn.
- Review độc lập phát hiện thưởng cọc chưa đăng ký người nhận; đã sửa nhập tên tại
  phiếu thưởng cọc, giữ request khi thử lại và kiểm fingerprint. Re-review không còn finding.
- Reconcile tiền v1/v2 và build/bundle đạt. Các bước gate/PR/migration/promote phải
  lấy biên nhận của lần phát hành; không dùng tài liệu này thay biên nhận.
