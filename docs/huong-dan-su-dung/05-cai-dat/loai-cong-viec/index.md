---
title: "Loại công việc"
description: "Danh mục loại công việc vận hành: đặt mức thưởng, cờ việc sửa chữa và cờ ký hợp đồng để dùng khi tạo công việc."
routes: ["/settings/categories/task-types"]
permissions: [{module: task_types, action: view}, {module: task_types, action: create}, {module: task_types, action: edit}, {module: task_types, action: delete}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Loại công việc

Trang **Loại công việc** là nơi bạn khai báo các "khuôn" công việc vận hành (ví dụ: sửa điện, sửa nước, ký hợp đồng, kiểm tra nhà). Mỗi loại việc mang sẵn **mức độ ưu tiên**, các **deadline** (phút), **bộ phận thực hiện**, và — quan trọng cho lương — **mức thưởng khi hoàn thành**, **cờ việc sửa chữa** và **cờ việc ký hợp đồng**. Khi nhân viên **tạo một công việc**, họ chọn loại việc ở đây; lúc việc **hoàn thành**, hệ thống dựa vào cấu hình thưởng của loại việc để cộng vào **Bảng lương quản lý**. Vì vậy đây là nơi bạn thiết lập một lần "loại việc nào có thưởng, thưởng bao nhiêu".

::: info Điều kiện tiên quyết
- Bạn cần quyền **Loại công việc => Xem** (module `task_types`, action `view`) để mở trang; cần quyền **Thêm / Sửa / Xoá** tương ứng để chỉnh danh mục.
- Trang nằm trong nhóm **Cài đặt hệ thống**, truy cập qua **Cài đặt hệ thống** => **Danh mục khác** => **Loại công việc**.
- Đây là danh mục **dùng chung theo tài khoản** (không phân theo tòa nhà) — sửa một chỗ áp dụng cho mọi tòa.
- Muốn mức thưởng chảy vào lương thật, cần đã cấu hình người hưởng lương ở [Bảng lương quản lý](/03-quan-ly-van-hanh/bang-luong/).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt hệ thống** => **Danh mục khác**, rồi chọn **Loại công việc**. Màn danh sách mở ra tại đường dẫn `/settings/categories/task-types`, bảng có các cột **Thao tác**, **Tên loại công việc**, **Bộ phận phụ trách**, **Nhóm công việc**, **Hạn gọi cho khách (phút)**, **Hạn tiếp nhận công việc (phút)**, **Hạn hoàn thành (phút)**, **Tính giờ hành chính**; mỗi trang 20 dòng. Dùng ô **Tìm kiếm...** để lọc nhanh theo tên. DEMO (07/10/2026) chưa có loại việc nào nên bảng hiện *"Chưa có loại công việc nào. Hãy thêm mới."*

![Màn Loại công việc của DEMO: ô Tìm kiếm, bảng 8 cột đang trống, nút Thêm loại công việc](./images/buoc-01-man-hinh.webp)

**Bước 2**: Ấn nút **Thêm loại công việc** (nút xanh góc trên phải). Hộp thoại **THÊM LOẠI CÔNG VIỆC** mở ra. Điền phần thông tin chung:
- **Tên loại công việc** (bắt buộc) — ví dụ "Sửa điện", "Ký hợp đồng".
- **Nhóm công việc** (bắt buộc) — chọn nhóm sẵn có, hoặc chọn **+ Thêm nhóm mới** để tạo ngay.
- **Mức độ ưu tiên** — mặc định **Bình thường**.
- **Deadline liên hệ KH / tiếp nhận / hoàn thành** — tính theo **phút**, để **0** nếu không áp dụng.
- **Tính giờ hành chính (9h - 18h)** — bật nếu deadline chỉ đếm trong giờ làm việc.
- **Bộ phận thực hiện** (bắt buộc) — bộ phận mặc định nhận việc loại này.

![Hộp THÊM LOẠI CÔNG VIỆC: Tên loại công việc, Nhóm công việc, Mức độ ưu tiên Bình thường, ba ô Deadline theo phút, Tính giờ hành chính, Bộ phận thực hiện](./images/buoc-02-form-them.webp)

**Bước 3**: Cuộn xuống khối **Bảng lương quản lý** trong hộp thoại — đây là phần quyết định thưởng. Cấu hình 4 mục:
- **Tiền thưởng khi hoàn thành (đ)** — số tiền cộng cho nhân viên **mỗi lần hoàn thành** một việc thuộc loại này (ví dụ **1.000.000đ**). Để **0** nếu loại việc không thưởng.
- **Là việc sửa chữa** — bật cho các việc sửa chữa. Cờ này dùng cho **phụ cấp Chủ nhật/Lễ** (mỗi ngày CN/Lễ có ít nhất một việc sửa chữa được cộng phụ cấp), và thưởng theo việc của loại này **luôn được tính**.
- **Là việc ký hợp đồng** — bật cho việc ký hợp đồng (loại "checkin"). Thưởng của cờ này **chỉ được cộng khi việc hoàn thành sau 18h hoặc vào Chủ nhật/Lễ** (thưởng ký hợp đồng ngoài giờ, mặc định **+50.000đ**).
- **Tính vào lương** — công tắc tổng, **mặc định bật** khi thêm mới: bật thì loại việc này góp vào bảng kê/lương; tắt thì dù có nhập tiền thưởng, việc loại này **không** cộng vào lương.

![Khối Bảng lương quản lý trong hộp thoại: Tiền thưởng khi hoàn thành, Là việc sửa chữa, Là việc ký hợp đồng, Tính vào lương đang bật, nút Huỷ và Lưu](./images/buoc-03-bang-luong.webp)

**Bước 4**: Ấn **Lưu** (nút đổi thành *Đang lưu...* trong lúc gửi). Lưu không được thì hộp báo lỗi ngay trên form, dạng *"Chưa lưu được loại công việc…"*. Loại việc mới xuất hiện trong danh sách và sẵn sàng để nhân viên chọn khi **tạo công việc**. Từ nay mỗi việc thuộc loại này khi **hoàn thành** sẽ tự chảy thưởng vào [Bảng lương quản lý](/03-quan-ly-van-hanh/bang-luong/) theo cấu hình vừa đặt.

**Bước 5**: Để chỉnh sửa hoặc gỡ một loại việc, dùng nút **bút chì** (mở hộp **SỬA LOẠI CÔNG VIỆC**) hoặc **thùng rác** (mở hộp **Xác nhận xoá** — *"Bạn có chắc chắn muốn xoá loại công việc này không?"*) ở cột **Thao tác** đầu mỗi dòng.

::: warning Đổi mức thưởng ảnh hưởng lương các tháng chưa chốt
Thay đổi **Tiền thưởng khi hoàn thành** hay các cờ ở đây sẽ tính lại thưởng cho những việc thuộc **tháng lương chưa chốt**. Các **tháng đã chốt** đã đóng băng con số nên **không** bị đổi. Vì vậy hãy đặt mức thưởng cho đúng **trước** khi nhân viên hoàn thành hàng loạt việc, tránh phải giải thích chênh lệch về sau.
:::

::: warning Xoá loại việc là thao tác khó hoàn tác
Xoá một loại công việc bỏ nó khỏi danh sách chọn khi tạo việc mới. Nếu loại việc đang được dùng, hãy cân nhắc chỉ **sửa** (ví dụ tắt **Tính vào lương**) thay vì xoá, để không mất lịch sử tham chiếu của các công việc cũ.
:::

## Các tính năng khác trên màn hình

| Nút / Khu vực | Công dụng |
| --- | --- |
| **Thêm loại công việc** | Mở hộp thoại tạo loại việc mới. |
| Ô **Tìm kiếm...** | Lọc nhanh danh sách theo tên loại việc. |
| Cột **Thao tác** (bút chì / thùng rác) | Sửa hoặc xoá một loại việc. |
| **Nhóm công việc** (trong form) | Gom các loại việc vào nhóm; có tuỳ chọn **+ Thêm nhóm mới** ngay tại chỗ. |
| **Deadline** liên hệ / tiếp nhận / hoàn thành | Mốc thời gian (phút) áp cho việc thuộc loại này; để 0 là không quy định. |
| **Tính giờ hành chính (9h - 18h)** | Chỉ đếm deadline trong giờ làm việc. |
| **Bộ phận thực hiện** | Bộ phận mặc định nhận việc loại này. |
| Khối **Bảng lương quản lý** | Nơi đặt **Tiền thưởng**, **Là việc sửa chữa**, **Là việc ký hợp đồng**, **Tính vào lương**. |
| **Quay lại Danh mục khác** | Liên kết về trang tổng hợp danh mục. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Nhân viên hoàn thành việc nhưng **không được thưởng** | Kiểm tra loại việc: **Tính vào lương** phải bật, và có **Tiền thưởng > 0** hoặc bật **Là việc sửa chữa**. Nếu Bảng lương đang bật "yêu cầu ảnh" mà việc thiếu ảnh thì cũng không thưởng. |
| Việc **ký hợp đồng** hoàn thành trong giờ hành chính mà không có **+50.000đ** | Đúng thiết kế: thưởng ký hợp đồng chỉ cộng khi hoàn thành **sau 18h hoặc CN/Lễ**. Trong giờ ngày thường sẽ không có khoản này. |
| Bật **Tiền thưởng** nhưng lương vẫn không cộng | Công tắc **Tính vào lương** đang tắt — đây là công tắc tổng, phải bật thì mức thưởng mới có hiệu lực. |
| Không thấy **phụ cấp Chủ nhật/Lễ** cho việc sửa | Việc đó phải bật cờ **Là việc sửa chữa** (hoặc là việc ký hợp đồng), và ngày hoàn thành phải rơi vào **Chủ nhật/Lễ** theo danh sách ngày lễ trong Bảng lương. |
| Sửa mức thưởng mà **tháng cũ không đổi** | Tháng lương đã **chốt** đóng băng số, không tính lại. Chỉ tháng chưa chốt mới áp mức mới. |
| Bấm thẻ **Loại công việc** bị đưa về **Bảng tin** | Tài khoản chưa có quyền **Loại công việc** (xem). Nhờ chủ nhà cấp quyền ở [Phân quyền](/05-cai-dat/phan-quyen/). |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/categories/task-types" app-label="Mở màn Loại công việc" fixtures="Snapshot 07/10/2026: DEMO chưa có loại công việc nào" view-only>

Bài này **chỉ xem** — bạn quan sát cấu hình, không lưu thay đổi:

1. Mở màn **Loại công việc**; DEMO hiện chưa có loại việc nào nên bảng trống.
2. Ấn **Thêm loại công việc** để mở hộp, cuộn xuống khối **Bảng lương quản lý** để thấy 4 mục thưởng: **Tiền thưởng khi hoàn thành**, **Là việc sửa chữa**, **Là việc ký hợp đồng**, **Tính vào lương**.
3. Đóng hộp bằng **Huỷ** — không bấm **Lưu**.

Kết quả mong đợi: bạn hình dung được mỗi loại việc mang theo một quy tắc thưởng riêng, và chính cấu hình này quyết định số tiền cộng vào lương khi việc hoàn thành. Không có dữ liệu DEMO nào bị tạo.

</SandboxTry>

## Quy trình liên quan

- [Danh mục khác](/05-cai-dat/danh-muc-khac/) — trang tổng hợp điều hướng sang mọi danh mục con.
- [Danh mục chung](/05-cai-dat/danh-muc-chung/) — nơi gom các danh mục dùng chung của hệ thống.
- [Bảng lương quản lý](/03-quan-ly-van-hanh/bang-luong/) — nơi mức thưởng của loại việc chảy vào lương nhân viên.
- [Việc của tôi](/02-theo-doi-nhanh/viec-cua-toi/) — việc hoàn thành theo loại việc là nguồn thưởng.
