---
title: "Chờ duyệt"
description: "Xem các yêu cầu tài chính đang chờ chính bạn, duyệt hoặc từ chối an toàn."
routes: ["/approvals"]
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-20"
  account: demo.quanly
status: published
---

# Chờ duyệt

Trang **Chờ duyệt** là hộp thư cá nhân cho các giao dịch tài chính mà bạn đang là người duyệt. Máy chủ đã lọc theo tài khoản đăng nhập, nên người không có yêu cầu được giao sẽ thấy màn hình rỗng.

![Danh sách yêu cầu đang chờ duyệt](./images/approvals-list.png)

## Duyệt hoặc từ chối

1. Mở **Tài chính → Chờ duyệt** hoặc đường dẫn `/approvals`.
2. Kiểm tra loại giao dịch, số tiền, người tạo, tòa/sổ và nội dung.
3. Chọn **Duyệt** nếu chứng từ đúng. Chọn **Từ chối**, nhập lý do rõ ràng nếu cần trả lại.
4. Làm mới danh sách; yêu cầu đã quyết định sẽ không còn trong inbox.

::: warning Không duyệt thay cho việc kiểm tra
Người tạo không được tự duyệt request của mình. Duyệt có thể đồng thời ghi giao dịch vào sổ, vì vậy không bấm lại nhiều lần và không sửa trạng thái trực tiếp ở màn Thu chi.
:::

## Khi danh sách rỗng

![Không có yêu cầu chờ duyệt](./images/approvals-empty.png)

Điều này có nghĩa là hiện không có request nào đang chờ chính bạn. Nếu đồng nghiệp nói đã gửi nhưng bạn không thấy, hãy kiểm tra đúng tài khoản, role/scope, trạng thái request và người duyệt được rule chọn.

## Quy tắc phiếu thu chi

- Phiếu thường dưới ngưỡng của đơn vị có thể tự duyệt ngay.
- Phiếu chi từ ngưỡng trở lên và hạng mục đặc biệt luôn sinh nháp chờ duyệt.
- Ngưỡng do owner đặt tại [Cài đặt chung](/05-cai-dat/cai-dat-chung/).
