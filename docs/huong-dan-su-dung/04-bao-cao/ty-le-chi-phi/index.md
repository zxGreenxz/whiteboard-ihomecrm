---
title: "Báo cáo: Tỷ lệ chi phí"
description: "So chi theo item đã duyệt với tổng phiếu thu đã duyệt theo tháng, tòa và nhóm hạng mục."
routes: ["/reports/real-estate/expense-ratio"]
permissions: [{module: reports_real_estate, action: expense_ratio}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Tỷ lệ chi phí

Route cần `reports_real_estate.expense_ratio`. Báo cáo này là tỷ lệ **chi đã duyệt / thu đã duyệt**, không phải biên lợi nhuận P&L.

![Màn hình báo cáo Tỷ lệ chi phí](./images/buoc-01-man-hinh.webp)

## Phạm vi thời gian và bộ lọc

- Mặc định sáu tháng, từ đầu tháng cách đây năm tháng đến cuối tháng hiện tại.
- Dù người dùng chọn ngày giữa tháng, hook kéo mốc về đầu tháng và cuối tháng.
- Có thể lọc một tòa, kể cả tòa ảo do danh sách building gọi `includeVirtual: true`.
- Có thể lọc một `income_expense_types.category` của loại expense.
- Bộ lọc được lưu trong phiên.

## Mẫu số: tổng thu

Hook dùng `fetchAllRows`, nên phân trang đầy đủ các phiếu:

- `income_expenses.type = INCOME`.
- `approval_status = APPROVED`.
- Chưa xóa.
- `voucher_date` trong khoảng và tòa nếu chọn.

Mỗi tháng cộng `income_expenses.total_amount`. Đây là tổng phiếu thu approved, không phải invoice, không yêu cầu posting line và có thể gồm cọc hoặc khoản thu không phải doanh thu kinh doanh.

::: warning Nhãn giao diện đang sai
Thẻ **Tổng doanh thu** mô tả “Doanh thu ghi nhận trên invoice đã duyệt”, nhưng code thực tế đọc `income_expenses` loại INCOME. Hãy hiểu thẻ là **tổng thu approved** theo ngày phiếu.
:::

## Tử số: chi theo item

Hook cũng phân trang đầy đủ phiếu `EXPENSE` approved, chưa xóa, rồi duyệt các `income_expense_items`:

- Chỉ item có `income_expense_type.type = "expense"`.
- Số tiền lấy từ `item.amount`, không từ tổng phiếu.
- Nhóm lấy từ `income_expense_type.category`; thiếu nhóm vào **(Chưa phân nhóm)**.
- Khi chọn category, chỉ tử số/chi tiết chi được lọc; mẫu số tổng thu vẫn giữ nguyên.

## Cách tính và hiển thị

- Tỷ lệ tháng = tổng chi tháng / tổng thu tháng × 100.
- Tháng tổng thu bằng 0 có tỷ lệ `null`, hiển thị “—” và không nối đường biểu đồ.
- **Tỷ lệ TB** là trung bình số học của các tỷ lệ tháng có mẫu số >0, không phải `tổng chi / tổng thu` toàn kỳ.
- **Tháng đỉnh** là tháng có tỷ lệ lớn nhất.
- Biểu đồ thứ hai cộng chi theo tên loại hạng mục trong toàn khoảng.

Màu bảng: dưới 25% xanh, 25–<50% vàng, từ 50% đỏ. Đây là ngưỡng hiển thị, không phải chính sách kế toán.

## Đối chiếu

- Phiếu APPROVED nhưng chưa post vẫn có thể đi vào report này trong Finance V2 canonical; vì vậy số có thể khác [Dòng tiền](/04-bao-cao/dong-tien/) posting-aware.
- Cọc trong phiếu thu làm mẫu số tăng dù P&L loại cọc; vì vậy số khác [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/) là bình thường.
- File `ti-le-chi-phi-doanh-thu` xuất bảng theo tháng và từng category.

## Quy trình liên quan

- [Thu chi](/03-quan-ly-van-hanh/thu-chi/)
- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/)
- [Dòng tiền](/04-bao-cao/dong-tien/)
- [Phân tích tài chính](/04-bao-cao/phan-tich-tai-chinh/)
