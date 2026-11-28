---
title: "Chi phí theo tòa"
description: "Tra giá phí, cách duyệt và phần cam kết còn lại theo từng tòa, hạng mục và tháng."
routes: ["/finance/chi-phi-theo-toa"]
permissions: [{module: thu_tien, action: collect}]
audience: [chu-nha, quan-ly-toa]
status: published
---

# Chi phí theo tòa

Vào **Tài chính → Chi phí theo tòa**. Chọn **Tòa nhà** và **Tháng**. Bấm tên hạng mục để xem hoặc sửa. Hai liên kết cũ **Phí cố định** và **Cam kết chi** đều mở bảng này.

## Đọc một dòng

Người có quyền Thanh toán xem giá công bố của tòa được giao. Chủ công ty hoặc quản trị có thể xem thêm cách duyệt và hạn mức của công ty đã chọn.

| Cách duyệt khi đóng phí | Mức áp dụng | Kết quả khi lập phiếu |
|---|---|---|
| Duyệt đúng giá | Giá công bố có hiệu lực trong tháng | Đóng Internet trọn tháng đúng 500.000đ thì được duyệt. Đóng 480.000đ là lệch giá và chờ duyệt. |
| Duyệt trong hạn mức tháng | Cam kết đã ký cho tòa, hạng mục và tháng | Nếu còn 400.000đ, phiếu 400.000đ nằm trong hạn mức. Phiếu 500.000đ chờ duyệt. Phiếu đang chờ cũng giữ chỗ. |
| Duyệt theo trần điện nước | Trần của tòa hoặc công ty | Khi quy tắc này đang áp dụng, thiếu trần hoặc vượt trần thì phiếu chờ duyệt. |
| Theo ngưỡng và trần điện nước | Quyền của người lập, ngưỡng duyệt và trần điện nước | Hệ thống dùng quy trình đóng điện nước khi quy tắc theo cam kết chưa áp dụng cho khoản này. |
| Theo quy trình đóng phí | Chưa công bố giá | Luồng đóng phí cố định dùng cách duyệt mặc định. |

Các ví dụ giả định người lập dùng đúng sổ quỹ và phiếu chỉ có một khoản trong một tháng. Với kỳ nhiều tháng, hệ thống kiểm phạm vi cho các tháng của kỳ. Số tiền ra khỏi sổ quỹ khi phiếu ở trạng thái **Đã Chi**.

## Chỉnh giá, hạn mức hoặc cách duyệt

1. Mở dòng phí. **Gợi ý** là số điền sẵn ở Thanh toán. Sửa giá mỗi kỳ, mã khách hàng hoặc chủ hộ rồi bấm dấu tích. Muốn xóa số gợi ý, dùng biểu tượng cục tẩy.
2. Người có quyền công bố bấm **Công bố giá** hoặc **Đổi giá**, nhập mức phí mỗi tháng và chọn tháng bắt đầu. Tòa không phát sinh hạng mục có thể **Tắt hạng mục** và **Bật lại** khi cần.
3. Chủ công ty vào **Sửa quy tắc và phạm vi áp dụng**. Kiểu chi thuộc hạng mục của toàn công ty. Chọn **Theo cam kết** nếu cần ký hạn mức, sau đó dùng **Ký cam kết tháng** để nhập số tiền cho riêng tòa và tháng đang xem. Ô đã có phiếu giữ chỗ hoặc đã duyệt sẽ khóa sửa.
4. Chọn thời gian và bấm **Bật** để áp dụng cho phạm vi đã chọn. Phạm vi mới tác động đến cách duyệt khi bộ máy đang áp dụng. Trong **Phạm vi áp dụng** có thể quản lý các phạm vi chung cho nhiều tòa.

## Tra lý do một phiếu chờ duyệt

Mở **Lịch sử duyệt → Máy chấm thử**, tìm mã phiếu rồi xem **Cửa**, **Máy quyết** và nhãn **Đã áp**. Phiếu Thu chi lập tay, phiếu định kỳ, sinh hàng loạt và đóng phí có thể dùng quy trình khác nhau khi quy tắc tháng chưa áp dụng. Thẻ **Tự duyệt** giúp tra phiếu người lập đã tự duyệt theo quyền của mình.
