---
title: "Kho (địa điểm lưu)"
description: "Khai báo và quản lý danh mục kho — các địa điểm lưu tài sản và vật tư (tên kho, vị trí) dùng để tham chiếu trong toàn hệ thống."
routes: ["/settings/categories/warehouses"]
permissions: [{module: warehouses, action: view}, {module: warehouses, action: create}, {module: warehouses, action: edit}, {module: warehouses, action: delete}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Kho (địa điểm lưu)

Trang **Kho tài sản** là nơi bạn khai báo danh mục các **địa điểm lưu** — những chỗ cất giữ tài sản, nội thất và vật tư dự phòng như kho tầng hầm, phòng kỹ thuật, kho tổng... Mỗi kho chỉ gồm hai thông tin đơn giản: **Tên kho** và **Vị trí**. Bạn dùng danh mục này để ghi nhận và tham chiếu tài sản/vật tư của mình đang được cất ở đâu, tách khỏi các căn hộ đang cho thuê.

Đây là danh mục dùng chung ở cấp tài khoản (không tách theo từng tòa nhà). Hiện tại kho là **danh mục khai báo độc lập** để tham chiếu — bạn tạo và quản lý danh sách kho ở đây, còn việc ghi tài sản vào từng phòng/căn hộ được làm ở màn Tài sản.

::: info Điều kiện tiên quyết
- Quyền **Kho => Xem** (module `warehouses`, action `view`) để mở danh mục.
- Quyền **Thêm / Sửa / Xoá** trên Kho nếu muốn tạo mới, chỉnh sửa hoặc xoá một kho.
- Trang nằm trong nhóm **Cài đặt hệ thống**, truy cập qua **Cài đặt** => **Danh mục khác** => nhóm **Tài sản** => **Kho**.
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Danh mục khác**. Trong nhóm **Tài sản**, chọn **Kho**. Trang mở ra tại đường dẫn `/settings/categories/warehouses` với tiêu đề **Kho tài sản**.

**Bước 2**: Xem bảng danh sách kho. Bảng có các cột **Tên kho**, **Vị trí** và **Thao tác** (nút Sửa / Xoá của từng dòng). Nếu chưa khai kho nào, màn hiện dòng "Chưa có dữ liệu. Hãy thêm mới.".

**Bước 3**: Muốn thêm một kho mới, ấn nút **Thêm mới** ở góc phải trên. Trong form:
- Nhập **Tên kho** (bắt buộc) — ví dụ "Kho DEMO A - Tầng hầm".
- Nhập **Vị trí** (tuỳ chọn, ô nhiều dòng) — mô tả nơi đặt kho, ví dụ "Tầng hầm Tòa DEMO A, cạnh chỗ để xe".
- Ấn **Thêm mới** để lưu. Kho vừa tạo xuất hiện ngay trong bảng.

**Bước 4**: Muốn chỉnh sửa, ấn biểu tượng **bút chì** (Sửa) trên dòng kho. Form mở ra với tiêu đề **Cập nhật** kèm sẵn Tên kho / Vị trí hiện tại. Sửa xong ấn **Cập nhật**.

**Bước 5**: Muốn xoá một kho, ấn biểu tượng **thùng rác** (Xoá) trên dòng đó. Hộp thoại **Xác nhận xóa** hiện ra với thông báo "Bạn có chắc chắn muốn xóa không? Hành động này không thể hoàn tác." — ấn **Xóa** để xác nhận, hoặc **Hủy** để giữ lại.

::: warning Xoá kho là xoá vĩnh viễn
Nút **Xoá** ở đây **xoá hẳn** bản ghi kho khỏi hệ thống (không phải ẩn tạm), và **không thể hoàn tác**. Nếu lỡ xoá nhầm, bạn phải tạo lại kho bằng tay. Chỉ xoá những kho thực sự không còn dùng; nếu chỉ tạm ngừng, cân nhắc đổi tên (ví dụ thêm "(ngừng dùng)") thay vì xoá.
:::

**Bước 6**: Muốn quay về trang tổng hợp danh mục, ấn liên kết **Quay lại Danh mục khác** ở góc trái trên.

## Các tính năng khác trên màn hình

| Nút / Thành phần | Công dụng |
| --- | --- |
| Nút **Thêm mới** | Mở form tạo kho mới (Tên kho + Vị trí). |
| Biểu tượng **Sửa** (bút chì) | Mở form chỉnh Tên kho / Vị trí của dòng đang chọn. |
| Biểu tượng **Xoá** (thùng rác) | Xoá vĩnh viễn kho (có bước xác nhận trước khi xoá). |
| Liên kết **Quay lại Danh mục khác** | Trở về trang danh mục tổng hợp (`/settings/categories`). |
| Trường **Tên kho** | Bắt buộc, không được để trống — dùng để nhận diện kho. |
| Trường **Vị trí** | Mô tả tuỳ chọn (ô nhập nhiều dòng) ghi chú nơi đặt kho. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy mục **Kho** trong **Danh mục khác** | Tài khoản của bạn chưa có quyền **Kho => Xem** (module `warehouses`). Nhờ chủ nhà cấp quyền trong phần phân quyền nhân viên. |
| Ấn **Thêm mới** / **Cập nhật** nhưng không lưu được | Thường do bỏ trống **Tên kho** (trường bắt buộc). Nhập tên kho rồi lưu lại. |
| Lỡ xoá nhầm một kho, muốn khôi phục | Xoá kho là **vĩnh viễn**, không có thùng rác để khôi phục. Bạn phải tạo lại kho bằng tay (Tên + Vị trí như cũ). |
| Không có ô lọc theo tòa nhà trên màn này | Đúng thiết kế: kho là danh mục **phẳng theo tài khoản**, dùng chung cho mọi tòa, không phân theo từng tòa nhà. |
| Danh sách trống dù chắc chắn đã tạo kho | Thường do quyền: nhân viên chỉ thấy dữ liệu theo quyền được cấp. Kiểm tra lại quyền **Kho => Xem** hoặc nhờ quản lý cấp quyền. |
| Tạo kho nhưng không thấy nó tự gắn vào tài sản nào | Kho hiện là **danh mục khai báo để tham chiếu** — hệ thống chưa tự động gắn kho vào từng tài sản hay phiếu di chuyển. Dùng danh sách này để ghi chú/tra cứu địa điểm lưu. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.kythuat" app-path="/settings/categories/warehouses" view-only>

Xem danh sách kho:

1. Đọc bảng **Kho tài sản** — chú ý hai cột **Tên kho** và **Vị trí**.
2. Ấn biểu tượng **bút chì** (Sửa) trên một dòng để xem đầy đủ hai trường của form (không cần Lưu).
3. Để ý màn không có ô lọc theo tòa nhà — kho là danh mục dùng chung theo tài khoản.

Kết quả mong đợi: bạn hình dung được danh mục kho gồm những gì và biết chỗ để thêm/sửa/xoá một địa điểm lưu.

</SandboxTry>

## Quy trình liên quan

- [Danh mục chung](/05-cai-dat/danh-muc-chung/) — trang tổng hợp các danh mục dùng chung khác của hệ thống, cùng nhóm với danh mục Kho.
