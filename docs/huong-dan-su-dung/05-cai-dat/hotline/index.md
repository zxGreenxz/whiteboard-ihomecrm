---
title: "Hotline"
description: "Quản lý danh mục hotline/đường dây nóng hiển thị cho khách trên trang Phòng trống công khai."
routes: ["/settings/categories/hotlines"]
permissions: [{module: hotline, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Hotline

Hotline là danh bạ **số điện thoại/đường dây nóng** mà bạn muốn khách nhìn thấy để liên hệ. Khi khách mở **trang Phòng trống công khai** (link chia sẻ `/r/:token` bạn gửi cho sale/khách), số hotline này là nơi khách bấm **Gọi** hoặc **Zalo** để hỏi thuê phòng. Trang này giúp bạn **tạo, sửa, bật/tắt và xoá** các hotline; còn việc *chọn hotline nào hiện ra* thì làm ở tab **Cài đặt hiển thị** của **Sale Phòng**. Đây không phải nơi ghi tiền — chỉ là một danh mục cấu hình.

Nguyên tắc cần nhớ: nếu bạn **không chọn** hotline cụ thể ở phần Cài đặt hiển thị, trang công khai sẽ tự lấy **hotline đang hoạt động đầu tiên** của bạn. Vì vậy chỉ cần đánh dấu đúng **Trạng thái** ở đây là khách đã có số để gọi.

::: info Điều kiện tiên quyết
- Quyền xem/quản lý **Hotline** (`hotline.view`) — thường là chủ nhà hoặc quản lý toà.
- Không bắt buộc phải có gì trước đó: đây là một danh mục độc lập, tạo lúc nào cũng được.
- Nếu muốn hotline thật sự hiển thị cho khách, bạn cần đã dùng **trang Phòng trống công khai / Sale Phòng** (nơi có tab **Cài đặt hiển thị**).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Danh mục khác**, rồi mở thẻ **Quản lý Hotline**. Bạn thấy danh sách hotline hiện có với các cột **Tên**, **Số điện thoại**, **Mô tả**, **Trạng thái** (badge **Hoạt động** hoặc **Ngừng**) và cột **Thao tác**. Nếu chưa có hotline nào, màn hình hiện dòng "Chưa có dữ liệu. Hãy thêm mới."

**Bước 2**: Ấn **Thêm mới** ở góc trên bên phải để mở form tạo hotline.

**Bước 3**: Điền thông tin trong form:
- **Tên hotline** (bắt buộc, có dấu *): tên gợi nhớ, ví dụ `Hotline CSKH DEMO` hoặc `Zalo thuê phòng Tòa DEMO A`.
- **Số điện thoại** (bắt buộc, có dấu *): số khách sẽ bấm gọi, ví dụ `0900 000 000`.
- **Mô tả** (tuỳ chọn): ghi chú nội bộ, ví dụ "Trực từ 8h–20h".
- **Trạng thái**: tích ô **Đang hoạt động** để hotline sẵn sàng được chọn hiển thị. Bỏ tích nếu muốn giữ số trong danh mục nhưng chưa cho dùng.

**Bước 4**: Ấn **Thêm mới** trong form để lưu. Hệ thống báo "Hotline đã được tạo thành công" và dòng mới xuất hiện trong danh sách với badge **Hoạt động** (nếu bạn đã tích Trạng thái).

**Bước 5**: (Tuỳ chọn) Chọn hotline này để hiển thị cho khách. Sang **Sale Phòng** => tab **Cài đặt hiển thị**, ở ô **Hotline hiển thị** chọn đúng hotline vừa tạo (định dạng "Tên · Số điện thoại"), rồi ấn **Lưu cài đặt**. Để nguyên "Mặc định (hotline đầu tiên)" thì trang tự lấy hotline hoạt động đầu tiên.

**Bước 6**: Sửa hoặc xoá khi cần. Trên mỗi dòng, ấn nút **bút chì** (Sửa) để mở lại form và chỉnh, hoặc nút **thùng rác** (Xoá) để xoá hotline (hệ thống hỏi xác nhận trước).

::: tip Số nào thật sự hiện ra cho khách — thứ tự ưu tiên
Trên trang Phòng trống công khai, số liên hệ của một phòng **thường** được chọn theo thứ tự: **Liên hệ QL riêng của toà** (nếu toà đã điền số liên hệ công khai trong màn Toà nhà) đè lên **hotline được chọn ở Cài đặt hiển thị**, đè lên **hotline hoạt động đầu tiên**. Riêng phòng dạng **"khách nhờ sale" (pass)**: nếu khách bật "Liên hệ quản lý" thì trang che số khách và dùng số QL/hotline của toà; ngược lại dùng thẳng số khách. Nên nếu đã cấu hình hotline mà khách vẫn thấy số khác, hãy kiểm tra xem toà đó có đặt **Liên hệ QL riêng** không.
:::

::: warning Xoá hotline không hoàn tác được
Nút **thùng rác** xoá hẳn hotline khỏi danh mục — hộp thoại **Xác nhận xóa** ghi rõ "Hành động này không thể hoàn tác". Nếu bạn xoá đúng hotline đang được chọn ở **Cài đặt hiển thị**, trang công khai sẽ **rơi về hotline hoạt động đầu tiên** (hoặc không còn số nào nếu bạn xoá hết). Muốn tạm ẩn một số mà vẫn giữ lại, hãy **bỏ tích Trạng thái** (chuyển sang **Ngừng**) thay vì xoá.
:::

## Các tính năng khác trên màn hình

| Nút / Cột | Công dụng |
| --- | --- |
| **Thêm mới** | Mở form tạo hotline mới. |
| **Tên** (cột) | Tên gợi nhớ của hotline. |
| **Số điện thoại** (cột) | Số khách sẽ bấm **Gọi** / **Zalo** trên trang công khai. |
| **Mô tả** (cột) | Ghi chú nội bộ, không hiển thị cho khách. |
| **Trạng thái** (cột) | Badge **Hoạt động** / **Ngừng** — chỉ hotline **Hoạt động** mới được chọn hiển thị và mới dùng làm "hotline đầu tiên" mặc định. |
| **Bút chì** (Sửa) | Mở lại form để đổi tên, số, mô tả hoặc bật/tắt trạng thái. |
| **Thùng rác** (Xoá) | Xoá hotline (có xác nhận, không hoàn tác). |
| **Đang hoạt động** (ô tích trong form) | Bật/tắt hotline; tắt để tạm ẩn khỏi lựa chọn hiển thị mà không mất dữ liệu. |
| **Quay lại Danh mục khác** | Link ở góc trên trái để trở về trang **Danh mục khác**. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Khách mở trang Phòng trống mà không thấy số nào để gọi | Chưa có hotline nào ở trạng thái **Hoạt động**. Tạo hotline mới và tích **Đang hoạt động**, hoặc bật lại một hotline đang **Ngừng**. |
| Trang công khai hiện **sai số** so với hotline bạn muốn | Bạn có nhiều hotline nên hệ thống lấy **hotline hoạt động đầu tiên**. Vào **Sale Phòng** => **Cài đặt hiển thị**, chọn đúng **Hotline hiển thị** rồi Lưu. |
| Đã chọn hotline ở Cài đặt hiển thị nhưng khách vẫn thấy số khác | Toà đó có **Liên hệ QL riêng** (số liên hệ công khai của toà) đang đè lên hotline chung; hoặc phòng đang ở dạng **pass** dùng số khách/QL. Kiểm tra cấu hình liên hệ ở màn Toà nhà. |
| Lỡ xoá hotline đang được chọn hiển thị | Tạo lại hotline và chọn lại ở **Cài đặt hiển thị**. Trong lúc chờ, trang tự dùng hotline hoạt động đầu tiên. |
| Không lưu được form | Thiếu ô bắt buộc: **Tên hotline** và **Số điện thoại** (có dấu *) phải được điền. |
| Muốn ngừng một số nhưng vẫn giữ lại để dùng sau | Đừng xoá — mở **Sửa** và **bỏ tích Trạng thái** để chuyển hotline sang **Ngừng**. |
| Nhân viên không thấy mục Hotline | Thiếu quyền `hotline.view`. Nhờ chủ nhà cấp quyền ở trang phân quyền. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/settings/categories/hotlines" view-only>

Bài xem: **Xem hotline cấu hình.**

1. Từ menu, vào **Cài đặt** => **Danh mục khác** => **Quản lý Hotline** (hoặc mở thẳng đường dẫn trên).
2. Đọc danh sách hotline: chú ý các cột **Tên**, **Số điện thoại**, **Mô tả** và **Trạng thái**. Phân biệt badge **Hoạt động** với **Ngừng** — chỉ số **Hoạt động** mới được đưa ra cho khách trên trang Phòng trống.
3. Nếu danh sách trống, bạn sẽ thấy dòng "Chưa có dữ liệu. Hãy thêm mới." — nghĩa là chưa có hotline nào để hiển thị cho khách.

Kết quả mong đợi: bạn hiểu **Hotline chỉ là danh bạ số liên hệ** cấp cho trang Phòng trống công khai; muốn khách thấy số nào thì bật **Trạng thái** ở đây và (nếu cần) chọn số đó tại **Cài đặt hiển thị** của **Sale Phòng**.

</SandboxTry>

## Quy trình liên quan

- [Danh mục khác](/05-cai-dat/danh-muc-khac/) — trang chứa lối vào **Quản lý Hotline** cùng các danh mục phụ khác.
- [Toà nhà](/03-quan-ly-van-hanh/toa-nha/) — nơi đặt **Liên hệ QL riêng** của từng toà, có thể đè lên hotline chung.
- [Phân quyền](/05-cai-dat/phan-quyen/) — cấp quyền `hotline.view` để nhân viên xem/quản lý hotline.
