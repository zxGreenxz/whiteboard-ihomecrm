---
title: "Phân quyền theo trang (mẫu quyền)"
description: "Tạo và chỉnh mẫu phân quyền theo từng trang (3 mức Xem/Quản lý/Nhạy cảm), gán mẫu cho nhân viên và đối chiếu quyền khác mẫu."
routes: ["/settings/staff"]
permissions: [{module: users, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Phân quyền theo trang (mẫu quyền)

Màn hình này để bạn quản lý **mẫu phân quyền** — bộ quyền tái sử dụng mô tả "nhân viên được làm gì trên từng trang của phần mềm". Danh mục quyền được liệt kê **theo từng trang** (gần 40 trang chia thành 10 nhóm như Bất động sản, Hợp đồng, Thu chi, Báo cáo, Cấu hình…), mỗi trang lại tách quyền thành **3 mức**: **Xem** (view), **Quản lý** (manage, thêm/sửa/xoá/duyệt) và **Nhạy cảm** (elevated — thao tác dễ ảnh hưởng tiền hoặc phân quyền). Phần mềm có sẵn **4 mẫu hệ thống** (**Super Admin**, **Quản Lý Tòa**, **Partner**, **Viewer**); bạn có thể **nhân bản** rồi tinh chỉnh thành mẫu riêng, sau đó **gán mẫu cho nhân viên** và theo dõi khi quyền của một người bị chỉnh **khác mẫu**.

Mẫu quyền chỉ quyết định **"làm được gì"**. Còn **"làm ở toà nào"** là một chiều kiểm soát riêng — **phạm vi toà** — được chọn khi bạn thêm/sửa nhân viên, độc lập với mẫu quyền.

::: info Điều kiện tiên quyết
- Tài khoản có quyền **Xem** trang phân quyền (module `users`) để mở màn hình; muốn tạo/sửa mẫu cần thêm quyền **Quản lý mẫu phân quyền** (`users.manage_templates`).
- Vào được **Cài đặt** => **Nhân viên & Đội ngũ**. Chủ nhà (Super Admin) luôn có đủ quyền này.
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Nhân viên & Đội ngũ**, rồi chọn tab **Mẫu phân quyền**.

![Màn hình](./images/buoc-01-man-hinh.webp)

**Bước 2**: Xem danh sách mẫu. Bốn thẻ đầu là **mẫu hệ thống** — **Super Admin** (toàn quyền), **Quản Lý Tòa** (quản lý vận hành 1+ toà), **Partner** (cộng tác viên: quản lý khách hẹn/cọc, xem hợp đồng), **Viewer** (chỉ xem). Bên dưới là các mẫu **tự tạo**. Mỗi thẻ hiển thị số **nhân viên đang dùng** mẫu đó.

**Bước 3**: Bấm vào một mẫu để mở **ma trận quyền theo trang**. Cột trái là danh sách trang chia theo 10 nhóm (mỗi trang có badge *số quyền đang bật / tổng*); panel phải liệt kê **từng chức năng** của trang với ô tích và mô tả. Quyền mức **Nhạy cảm** có badge **Nhạy cảm** để bạn nhận diện. Dùng ô **tìm kiếm** để lọc nhanh chức năng xuyên các trang.

::: warning Cân nhắc khi bật quyền "Nhạy cảm"
Các quyền gắn badge **Nhạy cảm** (ví dụ thu tiền, chia lợi nhuận, quản lý nhân sự, thao tác thanh lý) cho phép nhân viên **ghi nhận tiền hoặc thay đổi phân quyền**. Chỉ bật cho người thực sự cần; cấp nhầm rồi thu hồi vẫn có thể để lại dữ liệu đã tạo trước đó.
:::

**Bước 4**: Với **mẫu hệ thống**, ma trận ở chế độ **chỉ xem** (không sửa được). Muốn có bản chỉnh riêng, bấm **Tạo bản sao** để nhân bản thành mẫu tuỳ chỉnh, rồi mới sửa.

**Bước 5**: Với **mẫu tuỳ chỉnh**, tích/bỏ tích từng quyền. Mỗi trang có nút nhanh **Bỏ hết** / **Chỉ xem** / **Tất cả**; ngoài ra có nút preset áp cho **toàn bộ** mẫu. Đặt **tên mẫu** (bắt buộc, không để trống) rồi bấm **Lưu**.

**Bước 6 — Gán mẫu cho nhân viên**: Sang tab **Nhân viên**, mở một nhân viên (hoặc bấm **Thêm nhân viên**). Ở khu **Cài đặt nhanh**, chọn **một mẫu** — phần mềm **sao chép** toàn bộ quyền của mẫu cho nhân viên đó. Nếu cần, tinh chỉnh thêm ở khu **Tinh chỉnh từng quyền** (chỉnh riêng cho người này, không ảnh hưởng mẫu gốc hay người khác), rồi **Lưu**.

**Bước 7 — Đọc chênh lệch "khác mẫu"**: Trên thẻ mỗi nhân viên, phần mềm hiển thị trạng thái quyền: **Bypass toàn quyền** (Super Admin), **Khớp mẫu** (quyền y hệt mẫu) hoặc **N thay đổi so với mẫu** (đã tinh chỉnh khác mẫu). Đây là cách nhanh để biết ai đang có quyền lệch khỏi mẫu chuẩn.

## Các tính năng khác trên màn hình

| Nút / Thành phần | Công dụng |
|---|---|
| Tab **Nhân viên** | Thêm/sửa/xoá nhân viên và gán mẫu quyền + phạm vi toà cho từng người. |
| Tab **Đội ngũ** | Nhóm nhân viên thành đội để bàn giao tiền mặt nội đội và thấy tên nhau. |
| Tab **Mẫu phân quyền** | Danh sách mẫu quyền; nơi tạo/sửa/xoá và xem ma trận quyền theo trang. |
| **Tạo bản sao** | Nhân bản một mẫu (kể cả mẫu hệ thống) thành mẫu tuỳ chỉnh để chỉnh sửa. |
| Nút **Bỏ hết** / **Chỉ xem** / **Tất cả** | Đặt nhanh toàn bộ quyền của **một trang** về: tắt hết / chỉ mức Xem / bật hết. |
| Preset toàn cục | Áp một mức quyền chung cho **toàn bộ** các trang trong mẫu cùng lúc. |
| Ô **tìm kiếm** | Lọc nhanh chức năng theo tên, xuyên tất cả các trang. |
| Badge **Nhạy cảm** | Đánh dấu quyền mức elevated (dễ ảnh hưởng tiền / phân quyền). |
| Số **nhân viên đang dùng** | Trên mỗi thẻ mẫu, cho biết mẫu đang được gán cho bao nhiêu người. |
| Biểu tượng **sửa** / **xoá** (mẫu tuỳ chỉnh) | Đổi tên/quyền của mẫu, hoặc xoá mẫu (chặn nếu đang có người dùng). |

## Tình huống & lỗi thường gặp

| Tình huống | Nguyên nhân & cách xử lý |
|---|---|
| Không sửa được mẫu **Super Admin / Quản Lý Tòa / Partner / Viewer** | Đây là mẫu hệ thống, cố ý khoá để giữ chuẩn. Bấm **Tạo bản sao** rồi sửa trên bản sao. |
| Xoá mẫu báo không cho phép | Mẫu đang được gán cho ít nhất một nhân viên. Chuyển những người đó sang mẫu khác trước, rồi mới xoá. |
| Không thấy tab **Mẫu phân quyền** hoặc nút Thêm/Sửa | Thiếu quyền **Quản lý mẫu phân quyền** (`users.manage_templates`) hoặc chỉ có quyền Xem. Nhờ chủ nhà cấp thêm quyền module `users`. |
| Đã chỉnh quyền một nhân viên về **đúng mẫu** rồi Lưu nhưng thẻ vẫn hiện **N thay đổi so với mẫu** | Khi bạn chỉnh về khớp mẫu, chênh lệch bằng 0 nên hệ thống không ghi đè lại quyền đã tinh chỉnh trước đó. Cách chắc chắn: đổi nhân viên sang một mẫu khác rồi chọn lại đúng mẫu mong muốn để nạp mới quyền. |
| Nhân viên có quyền nhưng vẫn không thao tác được ở một toà | Quyền (mẫu) và **phạm vi toà** là hai chiều riêng. Kiểm tra lại phạm vi toà của người đó ở tab **Nhân viên** (khu vực / toà lẻ / tất cả toà). |
| Tinh chỉnh quyền một người nhưng sợ ảnh hưởng người khác | Không ảnh hưởng. Tinh chỉnh trong hồ sơ nhân viên chỉ áp cho riêng người đó; mẫu gốc và các nhân viên khác giữ nguyên. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/staff" view-only>

**Bài xem**

Mở tab **Mẫu phân quyền**, bấm vào một mẫu (ví dụ **Quản Lý Tòa**) để xem **ma trận quyền theo từng trang**: quan sát danh sách trang chia theo nhóm ở cột trái, các chức năng cùng ô tích ở panel phải, và badge **Nhạy cảm** ở những quyền dễ ảnh hưởng tiền — chỉ xem, không cần lưu.

</SandboxTry>

## Quy trình liên quan

- [Thêm nhân viên](/01-bat-dau/them-nhan-vien/)
- [Danh mục khác](/05-cai-dat/danh-muc-khac/)
