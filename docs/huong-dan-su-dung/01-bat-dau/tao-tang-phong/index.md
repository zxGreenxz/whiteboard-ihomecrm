---
title: "Bước 2: Tạo tầng & phòng"
description: "Thêm phòng cho toà nhà, khai báo giá thuê và tiền cọc, hiểu 5 trạng thái phòng tự cập nhật theo hợp đồng và cọc."
routes: ["/apartments"]
permissions: [{module: rooms, action: create}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bước 2: Tạo tầng & phòng

Sau khi có toà nhà, bạn khai báo từng **phòng** (căn hộ) bên trong — đây là đơn vị cho thuê thực tế mà mọi hợp đồng, hoá đơn, đồng hồ điện nước và phiếu thu chi sẽ neo vào. Trang này hướng dẫn bạn thêm phòng, điền giá thuê và tiền cọc, tạo tầng khi cần, và hiểu vì sao trạng thái phòng lại tự đổi màu mà không cần bạn sửa tay.

::: info Điều kiện tiên quyết

- Quyền **Căn hộ / Phòng => Thêm** (`rooms.create`).
- Đã tạo ít nhất **1 toà nhà đang hoạt động** ở Bước 1 — ô chọn toà trong form chỉ liệt kê toà có trạng thái **Đang hoạt động**.
- Nắm sẵn giá thuê và tiền cọc dự kiến của từng phòng (cả hai đều bắt buộc).

:::

## Hướng dẫn từng bước

**Bước 1**: Ở menu bên trái, vào **Căn hộ / Phòng**. Màn hình hiện danh sách toàn bộ phòng, sắp theo toà rồi tới tên phòng, kèm cột trạng thái, giá thuê và tiền cọc.

![Danh sách căn hộ của Tòa DEMO A với trạng thái, giá thuê và tiền cọc từng phòng](./images/buoc-01-danh-sach.webp)

**Bước 2**: Nếu danh sách dài, dùng ô **Tìm** và **Toà nhà** ở thanh lọc để thu hẹp về đúng toà bạn đang khai báo. Ô **Tầng** chỉ bật lên khi bạn đã chọn đúng 1 toà nhà.

**Bước 3**: Ấn **Thêm** (góc phải trên). Hộp thoại thêm phòng mở ra.

**Bước 4**: Chọn **Toà nhà** cho phòng. Danh sách chỉ hiện các toà **Đang hoạt động**. Nếu chưa có toà mong muốn, ấn mục **+ Thêm toà nhà** ngay trong ô chọn để tạo nhanh (chỉ cần tên + mã) rồi quay lại điền địa chỉ đầy đủ sau ở màn Toà nhà.

**Bước 5**: Chọn **Tầng**. Ô tầng lọc theo đúng toà vừa chọn. Nếu tầng chưa có trong danh sách, ấn **+ Thêm tầng** ngay trong ô chọn — đây là cách tạo tầng thật của hệ thống (điền số tầng, hệ thống tự gắn vào toà đang chọn).

::: tip Về danh mục Tầng
Bạn có thể xem lại toàn bộ tầng đã tạo ở **Cài đặt => Danh mục khác => Danh sách tầng**. Danh mục này chỉ dùng để **đặt tên và lọc** phòng theo tầng — nó không quyết định phòng thuộc tầng nào (số tầng nằm ngay trong từng phòng). Vì vậy nên tạo tầng qua nút **+ Thêm tầng** trong form phòng để chắc chắn tầng được gắn đúng toà.
:::

**Bước 6**: Điền **Tên phòng** (ví dụ `A101`). Tên phòng phải **duy nhất trong cùng một toà** — trùng tên trong toà sẽ bị chặn với thông báo "Tên phòng đã tồn tại trong toà nhà này". Tên phòng ở hai toà khác nhau thì được phép trùng.

**Bước 7**: Điền **Giá thuê** và **Tiền cọc**. Cả hai đều **bắt buộc** và không được âm (ví dụ giá thuê `3.000.000đ`, tiền cọc `3.000.000đ`). Đây là số mặc định hệ thống gợi ý khi bạn lập hợp đồng cho phòng.

**Bước 8**: (Tuỳ chọn) Điền thêm **Diện tích**, **Số người ở tối đa**, mô tả, ảnh nếu cần.

**Bước 9**: Ấn **Lưu**. Phòng mới xuất hiện trong danh sách với trạng thái mặc định **Trống** (AVAILABLE), và số phòng của toà tự tăng lên.

## Hiểu 5 trạng thái phòng

Cột trạng thái trên danh sách phản ánh tình trạng thực tế của phòng. Có 5 giá trị:

| Trạng thái (nhãn) | Ý nghĩa | Ai đặt |
| --- | --- | --- |
| **Trống** (AVAILABLE) | Chưa có khách, sẵn sàng cho thuê | Mặc định khi tạo phòng |
| **Đang thuê** (OCCUPIED) | Đang có hợp đồng còn hiệu lực | Tự động khi ký / kích hoạt hợp đồng |
| **Đã đặt cọc** (RESERVED) | Có phiếu cọc giữ chỗ nhưng chưa ký hợp đồng | Tự động khi thu cọc giữ chỗ |
| **Bảo trì** (MAINTENANCE) | Đang sửa chữa, tạm không cho thuê | Đặt tay khi cần |
| **Ngừng hoạt động** (UNAVAILABLE) | Không đưa vào khai thác | Đặt tay khi cần |

::: warning Trạng thái phòng chủ yếu tự động — đừng sửa tay
**Đang thuê** và **Đã đặt cọc** do hệ thống tự bật/tắt theo vòng đời hợp đồng và phiếu cọc, không phải bạn gán. Khi hợp đồng kết thúc, phòng tự trả về **Trống**; khi có phiếu cọc giữ chỗ (kể cả phiếu chưa duyệt), phòng tự chuyển **Đã đặt cọc**.

Công tắc bật/tắt nhanh trên bảng chỉ nên dùng cho cặp **Trống ⇄ Ngừng hoạt động**. Bật một phòng đang **Đang thuê** hay **Đã đặt cọc** về **Trống** có thể "mở bán" nhầm phòng đang có khách, và hệ thống không tự khôi phục lại trạng thái **Đang thuê**.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Ô **Tìm** | Tìm phòng theo tên, mã hoặc tên khách đang thuê. |
| **Toà nhà** | Lọc danh sách về đúng 1 toà (hoặc tất cả toà). |
| **Tầng** | Lọc theo tầng — chỉ bật khi đã chọn đúng 1 toà. |
| **Trạng thái** | Lọc theo Đang hoạt động / Đã đặt cọc / Ngừng hoạt động. |
| Thẻ thống kê | 4 thẻ: Tổng phòng, Tổng phòng trống, Đã đặt cọc, Sắp hết hạn — tính theo danh sách đang lọc. |
| Biểu tượng **sửa** | Mở lại hộp thoại để chỉnh giá thuê, tiền cọc, thông tin phòng. |
| Công tắc trạng thái | Bật/tắt nhanh Trống ⇄ Ngừng hoạt động (xem cảnh báo phía trên). |
| Biểu tượng **xoá** | Xoá mềm phòng (ẩn khỏi danh sách, số phòng của toà giảm theo). |

Các bộ lọc trên đều được **giữ nguyên khi bạn tải lại trang (F5)**, đóng tab mới trở về mặc định.

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy toà nhà trong ô chọn khi thêm phòng | Ô chọn chỉ liệt kê toà **Đang hoạt động**. Kiểm tra lại trạng thái toà ở Bước 1, hoặc dùng **+ Thêm toà nhà** để tạo nhanh. |
| Báo "Tên phòng đã tồn tại trong toà nhà này" | Trong một toà, tên phòng phải là duy nhất. Đổi tên khác, hoặc kiểm tra phòng cũ đã bị xoá mềm hay chưa. |
| Ô **Tầng** bị mờ, không chọn được | Ô tầng chỉ bật khi đã lọc đúng 1 toà nhà. Chọn 1 toà ở ô **Toà nhà** trước. |
| Không lưu được vì thiếu giá / cọc | **Giá thuê** và **Tiền cọc** đều bắt buộc và không được âm. Điền cả hai (nhập `0` nếu thực sự bằng 0). |
| Tạo tầng ở **Cài đặt => Danh mục khác => Danh sách tầng** báo lỗi | Nút Thêm ở trang danh mục tầng không gắn được toà nên sẽ báo lỗi. Hãy tạo tầng qua **+ Thêm tầng** trong form thêm phòng. |
| Phòng tự đổi sang **Đã đặt cọc** / **Đang thuê** dù bạn không sửa | Đây là hành vi đúng: trạng thái theo phiếu cọc và hợp đồng tự cập nhật. Không cần chỉnh tay. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/apartments" app-label="Mở màn Căn hộ / Phòng" fixtures="A101..A305, B101..B104">

Trong sandbox đã có sẵn các phòng của **Tòa DEMO A** (A101..A305) và **Tòa DEMO B** (B101..B104) ở nhiều trạng thái khác nhau.

1. Xem danh sách phòng, quan sát cột trạng thái, giá thuê và tiền cọc.
2. Lọc ô **Toà nhà** về **Tòa DEMO A** để chỉ còn các phòng A1xx–A3xx.
3. Ấn vào một phòng để mở chi tiết và xem thông tin đầy đủ.
4. Đối chiếu các phòng có trạng thái **Trống**, **Đã thuê**, **Giữ chỗ**, **Bảo trì**.

**Kết quả mong đợi:** bạn phân biệt được 4–5 trạng thái phòng qua màu/nhãn và hiểu phòng nào đang trống, đang thuê, đang giữ chỗ hay đang bảo trì.

</SandboxTry>

## Quy trình liên quan

- [Bước 1: Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/) — tạo toà nhà trước khi thêm phòng.
- [Bước 3: Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/) — khai báo điện, nước, phí dịch vụ cho phòng.
- [Sơ đồ toà nhà](/02-theo-doi-nhanh/so-do-toa-nha/) — xem trực quan tình trạng phòng theo tầng.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — quản lý phòng trong vận hành hằng ngày.
