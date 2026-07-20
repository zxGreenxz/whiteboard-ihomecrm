---
title: "Báo cáo tài chính (tổng quan)"
description: "Trung tâm 9 báo cáo tài chính hiện hành."
routes: ["/reports/finance"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-20"
  account: production
status: published
---

# Báo cáo tài chính

Hub `/reports/finance` hiện có **9 báo cáo**:

1. Phân tích tài chính.
2. Bàn giao tiền & đối soát sổ.
3. Chu kỳ Thu → Bàn giao.
4. Sổ quỹ theo ngày.
5. Dòng tiền.
6. Báo cáo lợi nhuận.
7. Lịch thanh toán.
8. Tiền thừa.
9. Danh sách tiền cọc.

![Hub báo cáo tài chính](./images/buoc-01-man-hinh.webp)

Hai báo cáo công nợ cũ không còn là trang báo cáo riêng. Các URL cũ **Công nợ HĐ mới** và **Khách nợ tiền** chuyển về `/thu-tien`, là nơi canonical để theo dõi và thu nợ theo phòng/khách.

## Cách đọc số

- Báo cáo dòng tiền/sổ quỹ đọc giao dịch đã có hiệu lực trong sổ.
- Lịch thanh toán/tiền thừa/cọc đọc trạng thái hóa đơn hoặc cọc tương ứng.
- Báo cáo lợi nhuận và phân tích tài chính có bộ lọc riêng; kiểm tra kỳ, tòa và chế độ tiền mặt/dồn tích trước khi xuất.

Mỗi thẻ có permission action riêng. Nếu mở hub được nhưng không vào được một báo cáo, nhờ owner kiểm tra [Phân quyền](/05-cai-dat/phan-quyen/).
