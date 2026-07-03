---
title: "Bước 3: Dịch vụ & định mức"
description: "Khai báo dịch vụ (điện, nước, rác, giữ xe), chọn cách tính tiền, gán vào từng toà với giá riêng và tạo định mức bậc thang."
routes: ["/services"]
permissions: [{module: services, action: create}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bước 3: Dịch vụ & định mức

Dịch vụ là các khoản thu ngoài tiền phòng: điện, nước, rác, giữ xe, phí dịch vụ chung… Ở bước này bạn khai báo **danh mục dịch vụ dùng chung cho mọi toà**, chọn **cách tính tiền** cho từng dịch vụ, rồi **gán vào từng toà** với giá riêng nếu cần. Đây là nền tảng để hệ thống tự tính đúng số tiền trên hoá đơn hàng tháng, nên hãy làm sau khi đã có toà nhà và trước khi ký hợp đồng.

::: info Điều kiện tiên quyết
- Quyền **Tạo dịch vụ** (`services.create`).
- Đã tạo ít nhất một toà nhà để gán dịch vụ (xem [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/)).
- Nếu tính giá luỹ tiến (điện bậc thang): chuẩn bị sẵn các mốc bậc và đơn giá từng bậc.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại thanh điều hướng, mở **Danh mục dữ liệu** => **Dịch vụ**. Màn hình liệt kê các dịch vụ hiện có với các cột **Mã**, **Tên**, **Loại phí**, **Loại tính tiền**, **Giá** (đơn giá kèm đơn vị) và **Mặc định**.

![Màn Dịch vụ liệt kê DEMO Điện, DEMO Nước, DEMO Rác, DEMO Giữ Xe kèm cách tính và đơn giá](./images/buoc-01-danh-sach.webp)

**Bước 2**: ấn **Thêm** ở góc trên. Hộp thoại tạo dịch vụ mở ra.

**Bước 3**: điền **Tên dịch vụ** (ví dụ "Tiền điện"), chọn **Loại phí** (Tiền điện / Tiền nước / Phí dịch vụ / Vệ sinh / Phí khác — loại phí quyết định dịch vụ hiện vào đúng cột nào trên hoá đơn), rồi chọn **Loại tính tiền**. Bốn cách tính tiền hệ thống hỗ trợ:

| Loại tính tiền | Cách tính | Ví dụ |
|---|---|---|
| **Cố định theo tháng** | Một khoản cố định mỗi tháng, không phụ thuộc số người hay số phòng | Phí dịch vụ chung, wifi |
| **Theo người** | Đơn giá nhân với số người đang ở trong phòng | Rác, giữ xe (tính đầu người) |
| **Theo phòng** | Mỗi phòng một khoản như nhau, dù ở bao nhiêu người | Phí vệ sinh theo phòng |
| **Theo đồng hồ** | Tính theo sản lượng tiêu thụ = (chỉ số mới − chỉ số cũ) × đơn giá | Điện (Kwh), nước (m³) |

**Bước 4**: điền **Đơn vị** (Phòng / Người / Kwh / m³ / Tháng…) và **Đơn giá** mặc định. Với dịch vụ **theo đồng hồ**, đơn giá là giá cho mỗi Kwh hoặc mỗi m³; hệ thống lấy chênh lệch chỉ số công tơ để tính ra sản lượng.

::: tip Dịch vụ theo đồng hồ cần công tơ
Điện và nước tính theo đồng hồ chỉ ra được số tiền khi phòng đã có **công tơ** để ghi chỉ số. Bạn khai báo dịch vụ ở đây trước, còn việc gắn công tơ vào phòng làm ở [Bước Công tơ điện nước](/01-bat-dau/cong-to/). Chưa có công tơ thì hoá đơn sẽ không có dòng điện/nước tương ứng.
:::

**Bước 5**: gán dịch vụ vào toà. Trong hộp thoại, tích chọn các **Toà nhà** sẽ áp dụng dịch vụ này. Nếu một toà dùng giá khác đơn giá chung (ví dụ Tòa DEMO A tính điện cao hơn Tòa DEMO B), điền **giá riêng theo toà** ở dòng toà đó — hệ thống sẽ ưu tiên giá riêng khi lập hoá đơn cho toà ấy.

::: tip Giá riêng đè lên giá chung
Giá riêng theo toà (nếu có) luôn **thắng** đơn giá mặc định của dịch vụ. Muốn một toà quay lại dùng giá chung, xoá ô giá riêng của toà đó rồi lưu lại.
:::

**Bước 6**: (tuỳ chọn) nếu dịch vụ tính **bậc thang / luỹ tiến** (thường là điện), chọn một **Định mức** ở ô định mức. Định mức được tạo riêng tại **Cài đặt** => **Định mức dịch vụ** — xem hộp bên dưới.

::: tip Tạo định mức bậc thang
Vào **Cài đặt** => **Định mức dịch vụ** và ấn **Thêm**. Đặt **Tên định mức** (ví dụ "Điện luỹ tiến"), rồi thêm từng **bậc**: mốc **Từ** – **Đến** và **đơn giá** trong khoảng đó. Bậc cuối cùng để **trống mốc Đến** nghĩa là vô cực (áp cho mọi lượng vượt bậc trước). Sau khi lưu, mở lại định mức để **kiểm tra đủ số bậc** đã nhập trước khi gắn vào dịch vụ.
:::

**Bước 7**: ấn **Lưu**. Dịch vụ mới xuất hiện ngay trong danh sách và sẵn sàng để chọn khi lập hợp đồng / hoá đơn cho các toà đã gán.

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
|---|---|
| Ô **tìm kiếm** | Tìm dịch vụ theo tên hoặc mã |
| Bộ lọc **Toà nhà** | Chỉ hiện các dịch vụ đã bật cho toà được chọn (dịch vụ chưa gán toà sẽ bị ẩn) |
| Bộ lọc **Loại phí** | Lọc theo Tiền điện / Tiền nước / Phí dịch vụ / Vệ sinh / Phí khác |
| Cột **Mặc định** | Đánh dấu dịch vụ được gợi ý sẵn khi lập hợp đồng (chỉ hiển thị trên bảng) |
| Nút **Sửa** | Mở lại hộp thoại để chỉnh dịch vụ, đổi cách tính, thêm/bớt toà và giá riêng |
| Nút **Xoá** | Ẩn dịch vụ khỏi danh mục (không xoá dữ liệu lịch sử đã dùng) |
| **Cài đặt** => **Định mức dịch vụ** | Tạo và sửa các bậc thang giá luỹ tiến |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
|---|---|
| Thêm dịch vụ nhưng một toà không thấy nó | Dịch vụ chưa được gán cho toà đó. Mở **Sửa**, tích chọn toà, rồi lưu lại. |
| Giá trên hoá đơn khác đơn giá chung | Toà đang dùng **giá riêng** (đè lên giá chung). Kiểm tra ô giá riêng theo toà trong hộp thoại dịch vụ. |
| Đổi đơn giá chung nhưng một toà vẫn tính giá cũ | Toà đó có giá riêng nên không đổi theo. Xoá ô giá riêng của toà để về giá chung. |
| Dịch vụ theo đồng hồ nhưng hoá đơn không có dòng điện/nước | Phòng chưa có công tơ để ghi chỉ số. Sang [Bước Công tơ điện nước](/01-bat-dau/cong-to/) gắn công tơ cho phòng. |
| Định mức đã lưu nhưng tính bậc thang bị sai / thiếu bậc | Mở lại định mức kiểm tra **đủ số bậc**, các khoảng **Từ – Đến** nối liền nhau và bậc cuối để trống mốc Đến. Sửa lại rồi lưu. |

::: warning Xoá dịch vụ
Xoá dịch vụ chỉ ẩn nó khỏi danh mục, không đụng tới hoá đơn/hợp đồng đã dùng dịch vụ đó. Nhưng dịch vụ đã ẩn sẽ không còn chọn được cho hợp đồng mới — cân nhắc trước khi xoá thay vì chỉ bỏ gán khỏi toà.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/services" app-label="Mở màn Dịch vụ" fixtures="DEMO Điện, DEMO Nước, DEMO Rác, DEMO Giữ Xe" view-only>

Mở màn **Dịch vụ** và quan sát 4 dịch vụ demo: **DEMO Điện**, **DEMO Nước**, **DEMO Rác**, **DEMO Giữ Xe**. Với mỗi dịch vụ, hãy nhìn vào cột **Loại tính tiền**, **Đơn vị** và **Giá**.

**Kết quả mong đợi**: bạn phân biệt được hai nhóm — dịch vụ **theo đồng hồ** (DEMO Điện tính theo Kwh, DEMO Nước tính theo m³, cần công tơ để ghi chỉ số) và dịch vụ tính **cố định / theo phòng / theo người** (DEMO Rác, DEMO Giữ Xe — không cần công tơ, ra số tiền ngay từ đơn giá và số người/số phòng).

</SandboxTry>

## Quy trình liên quan

- [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/) — phải có toà trước mới gán được dịch vụ.
- [Công tơ điện nước](/01-bat-dau/cong-to/) — bước tiếp theo cho các dịch vụ tính theo đồng hồ.
- [Dịch vụ (quản lý vận hành)](/03-quan-ly-van-hanh/dich-vu/) — quản lý dịch vụ trong quá trình vận hành hằng ngày.
