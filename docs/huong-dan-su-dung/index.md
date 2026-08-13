---
layout: home
markdownStyles: false

hero:
  name: "ptcrm"
  text: "Tài liệu vận hành hiện hành"
  tagline: Hướng dẫn theo đúng luồng màn hình, route, quyền và dữ liệu đang dùng — đối chiếu đến 13/08/2026
  actions:
    - theme: brand
      text: Bắt đầu sử dụng
      link: /01-bat-dau/gioi-thieu
    - theme: alt
      text: Quy trình khách thuê
      link: /01-bat-dau/quy-trinh-khach-thue
    - theme: alt
      text: Tra quyền nhanh
      link: /07-thong-tin-khac/tra-quyen-nhanh

features:
  - icon: 🚀
    title: Bắt đầu đúng thứ tự
    details: Đăng nhập, khởi tạo toà — tầng — phòng — dịch vụ — sổ quỹ, rồi đi theo các quy trình khách thuê, thu tiền, chốt tháng, bàn giao và thanh lý.
    link: /01-bat-dau/gioi-thieu
  - icon: 🏢
    title: Quản lý & vận hành
    details: Hướng dẫn từng màn hình cho toà nhà, phòng, khách hẹn, cọc, hợp đồng, chỉ số, hoá đơn, thu tiền, thu chi, sổ quỹ, tài sản, vật tư và công việc.
    link: /03-quan-ly-van-hanh/
  - icon: 📊
    title: Báo cáo có chỉ rõ nguồn số
    details: Phân biệt số vận hành, công nợ, dòng tiền đã ghi sổ, kết quả kinh doanh, cọc và tiền thừa; có cảnh báo ở các báo cáo còn dùng nguồn dữ liệu cũ.
    link: /04-bao-cao/
  - icon: 🛡️
    title: Quyền theo RBAC V3
    details: Membership, vai trò, binding, phạm vi và ngoại lệ ALLOW/DENY; catalog hiện có 231 khoá quyền, trong đó 223 khoá đang hiện ở bộ chọn quyền mặc định.
    link: /07-thong-tin-khac/tra-quyen-nhanh
  - icon: ⚙️
    title: Cài đặt & tài khoản
    details: Danh mục, biểu mẫu, thành viên, vai trò, thông báo và tài khoản cá nhân — dùng đúng route hiện hành, không dựa vào đường dẫn cũ đã chuyển hướng.
    link: /05-cai-dat/
  - icon: 🧭
    title: Kế hoạch phát triển — không phải runtime
    details: Khu 08 chứa đề xuất và tài liệu thảo luận. Nội dung ở đó chỉ trở thành tính năng khi đã có route, quyền, dữ liệu và kiểm chứng trong ứng dụng hiện hành.
    link: /08-ke-hoach-phat-trien/
---

## Cách dùng bộ tài liệu

1. Nếu mới dùng ptcrm, bắt đầu tại [Giới thiệu hệ thống](/01-bat-dau/gioi-thieu/) rồi làm phần **Khởi tạo dữ liệu** theo đúng thứ tự phụ thuộc.
2. Nếu đang xử lý một ca thực tế, mở đúng trang trong nhóm **Quản lý & vận hành** và đọc cả phần **Điều kiện trước khi làm**, **Kết quả sau khi lưu** và **Quyền cần có**.
3. Nếu số tiền chưa khớp, phân biệt rõ **đã duyệt** với **đã ghi sổ**. Chỉ posting còn hiệu lực (`POSTED`) mới là tiền thực đi vào hoặc đi ra sổ quỹ.
4. Nếu không thấy trang hoặc nút, tra [Bảng quyền nhanh](/07-thong-tin-khac/tra-quyen-nhanh/) rồi kiểm tra lần lượt membership, vai trò, phạm vi và ngoại lệ `DENY`.
5. Nếu giao diện khác tài liệu, đối chiếu [Ghi chú phiên bản](/07-thong-tin-khac/ghi-chu-phien-ban/) và gửi báo lỗi theo mẫu ở [Kênh hỗ trợ](/07-thong-tin-khac/kenh-ho-tro/).

::: warning Hai khái niệm tài chính không được dùng thay nhau
**Đã duyệt** là quyết định workflow; **Đã Thu / Đã Chi** là tiền đã được ghi vào sổ. Một phiếu có thể đã duyệt nhưng vẫn **chưa Thu / chưa Chi**, hoặc là bút toán **không qua sổ**. Khi đối soát tiền, luôn kiểm tra trạng thái ghi sổ và sổ quỹ liên quan.
:::

## Nguồn được ưu tiên khi có khác biệt

Tài liệu được đối chiếu theo thứ tự: **hành vi và route trong code hiện hành → contract/schema và catalog database production → quyền/RLS đang áp dụng → nội dung Markdown**. Trang **Lịch sử cập nhật** trong ứng dụng chỉ là danh sách tĩnh của build và không phải nhật ký phát hành đầy đủ. Khu **Kế hoạch phát triển** là đề xuất, không phải bằng chứng rằng tính năng đã được phát hành.
