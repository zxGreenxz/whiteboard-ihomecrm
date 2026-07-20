---
title: "Ghi chú phiên bản"
description: "Bộ tài liệu này bám theo phiên bản hệ thống hiện tại và được cập nhật khi có tính năng mới — cách xem Lịch sử cập nhật ngay trong ứng dụng."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-20"
  account: demo
status: published
---

# Ghi chú phiên bản

Bộ tài liệu hướng dẫn này được biên soạn bám sát **phiên bản hệ thống đang chạy thật** trên ptcrm. Vì phần mềm được cập nhật liên tục — thêm màn hình, đổi luồng nghiệp vụ, chỉnh nút bấm — nên mỗi trang hướng dẫn đều được viết lại hoặc bổ sung mỗi khi tính năng thay đổi. Trang này giải thích cách tài liệu được đánh dấu theo phiên bản và cách bạn tự xem **Lịch sử cập nhật** của ứng dụng.

## Tài liệu bám theo phiên bản nào

- Mỗi trang hướng dẫn được **chụp lại theo một mốc thời gian cụ thể**. Bạn thấy điều này ở đầu mỗi trang: ảnh minh hoạ và các bước thao tác phản ánh giao diện tại thời điểm được ghi.
- Bản tài liệu hiện tại được rà soát theo hệ thống ngày **20/07/2026**. Các trang mới nhất gồm **Chờ duyệt**, **Trợ lý AI**, mô hình approval/RBAC và trung tâm báo cáo 9 mục.
- Khi giao diện thật khác một chút so với ảnh trong tài liệu (ví dụ thêm một nút, đổi tên nhãn), đó là dấu hiệu trang đang chờ cập nhật — hãy ưu tiên làm theo những gì bạn thấy trên màn hình, phần mô tả nghiệp vụ vẫn đúng.

## Khi nào tài liệu được cập nhật

- **Có tính năng mới**: khi hệ thống bổ sung màn hình hoặc luồng nghiệp vụ, trang hướng dẫn liên quan sẽ được viết mới hoặc bổ sung mục tương ứng.
- **Đổi thao tác trên màn hình cũ**: nếu một nút, bộ lọc hay bước nhập liệu thay đổi, phần **Hướng dẫn từng bước** và bảng **Các tính năng khác** của trang đó được chỉnh lại.
- **Sửa lỗi mô tả**: khi phát hiện tài liệu ghi chưa khớp với hệ thống thật, phần đó được sửa mà không đổi cấu trúc trang.

## Xem Lịch sử cập nhật trong ứng dụng

Ứng dụng có trang **Lịch sử cập nhật**, nhưng nội dung trong app có thể ngắn hơn hoặc chậm hơn source docs. Dùng trang này để xem ghi chú UI; dùng bộ tài liệu và commit hiện hành làm nguồn mô tả nghiệp vụ.

- Mở đường dẫn **/changelog** trong ứng dụng để xem các ghi chú phát hành đang được hiển thị.
- Mỗi mục nêu ngắn gọn những gì được thêm, sửa hoặc cải thiện trong đợt phát hành đó.
- Nếu có khác biệt, ưu tiên hành vi thật trên màn hình và tài liệu có `captured.date` mới hơn; báo lại qua [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/).

::: tip Kết hợp hai nguồn
**Lịch sử cập nhật (/changelog)** là ghi chú trong app; bộ tài liệu này giải thích *cách dùng* và được rà soát theo mốc code/documentation. Khi có khác biệt, dùng ngày `captured` để chọn bản đáng tin hơn.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/changelog" app-label="Mở Lịch sử cập nhật" view-only>

Đăng nhập bằng `demo.chunha` và mở trang **/changelog**. Bạn nên nhìn thấy:

- Danh sách các bản cập nhật của hệ thống, đợt mới nhất nằm trên cùng.
- Mỗi mục mô tả ngắn gọn những thay đổi (thêm tính năng, sửa lỗi, cải thiện) của đợt đó.

</SandboxTry>

## Quy trình liên quan

- [Giới thiệu hệ thống](/01-bat-dau/gioi-thieu/) — ptcrm là gì và bản đồ 7 khu chức năng.
- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/) — giải đáp nhanh các thắc mắc khi dùng hệ thống.
- [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/) — nơi liên hệ khi cần trợ giúp hoặc góp ý về tính năng.
