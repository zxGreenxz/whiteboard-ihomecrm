---
title: "Bước 3: Dịch vụ & định mức"
description: "Khai báo dịch vụ (điện, nước, rác, giữ xe), chọn cách tính tiền, gán vào từng toà với giá riêng và tạo định mức bậc thang."
routes: ["/services", "/settings/categories/service-quotas"]
permissions: [{module: services, action: view}, {module: services, action: create}, {module: service_quotas, action: create}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Bước 3: Dịch vụ & định mức

Dịch vụ là các khoản thu ngoài tiền phòng: điện, nước, rác, giữ xe, phí dịch vụ chung… Ở bước này bạn khai báo **danh mục dịch vụ dùng chung cho mọi toà**, chọn **cách tính tiền** cho từng dịch vụ, rồi **gán vào từng toà** với giá riêng nếu cần. Đây là nền tảng để hệ thống tự tính đúng số tiền trên hoá đơn hàng tháng, nên hãy làm sau khi đã có toà nhà và trước khi ký hợp đồng.

::: info Điều kiện tiên quyết
- `services.view` để mở trang, `services.create` để thêm dịch vụ. Tạo định mức riêng cần `service_quotas.create`.
- Đã tạo ít nhất một toà nhà để gán dịch vụ (xem [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/)).
- Nếu tính giá luỹ tiến (điện bậc thang): chuẩn bị sẵn các mốc bậc và đơn giá từng bậc.
:::

## Hướng dẫn từng bước

**Bước 1**: Tại thanh điều hướng, mở **Quản lý & Vận hành** => **Dịch vụ** (`/services`). Màn hình liệt kê dịch vụ trong phạm vi dữ liệu của bạn.

Snapshot production ngày 13/08/2026 của `demo.chunha` có đúng 3 dòng: **DEMO Điện — 3.500**, **DEMO Nước — 100.000**, **DEMO Rác — 50.000**; không có dòng **DEMO Giữ Xe**.

![Màn Dịch vụ liệt kê các dòng dịch vụ và đơn giá đang được cấu hình](./images/buoc-01-danh-sach.webp)

**Bước 2**: ấn **Thêm** ở góc trên. Hộp thoại tạo dịch vụ mở ra.

**Bước 3**: điền **Tên dịch vụ**, chọn **Loại phí** (Tiền điện / Tiền nước / Phí dịch vụ / Vệ sinh / Phí khác), rồi chọn **Loại tính tiền**. Hệ thống hiện hỗ trợ năm lựa chọn:

| Loại tính tiền | Cách tính | Ví dụ |
|---|---|---|
| **Cố định theo tháng** | Một khoản cố định mỗi tháng, không phụ thuộc số người hay số phòng | Phí dịch vụ chung, wifi |
| **Theo người** | Đơn giá nhân với số người đang ở trong phòng | Rác, giữ xe (tính đầu người) |
| **Theo phòng** | Mỗi phòng một khoản như nhau, dù ở bao nhiêu người | Phí vệ sinh theo phòng |
| **Cố định theo đồng hồ** | Tính theo sản lượng tiêu thụ = (chỉ số mới − chỉ số cũ) × đơn giá | Điện (Kwh), nước (m³) |
| **Đơn giá biến động** | Đơn giá được xác định theo dữ liệu phát sinh/cấu hình nghiệp vụ | Khoản có giá thay đổi theo kỳ |

**Bước 4**: điền **Đơn vị** (Phòng / Người / Kwh / m³ / Tháng…) và **Đơn giá** mặc định. Với dịch vụ **theo đồng hồ**, đơn giá là giá cho mỗi Kwh hoặc mỗi m³; hệ thống lấy chênh lệch chỉ số công tơ để tính ra sản lượng.

::: tip Dịch vụ theo đồng hồ cần công tơ
Điện và nước tính theo đồng hồ chỉ ra được số tiền khi phòng đã có **công tơ** để ghi chỉ số. Bạn khai báo dịch vụ ở đây trước, còn việc gắn công tơ vào phòng làm ở [Bước Công tơ điện nước](/01-bat-dau/cong-to/). Chưa có công tơ thì hoá đơn sẽ không có dòng điện/nước tương ứng.
:::

**Bước 5**: gán dịch vụ vào toà. Form bắt buộc chọn **ít nhất một toà nhà**. Giá riêng theo toà, nếu được cấu hình ở phần toà nhà, sẽ ưu tiên hơn đơn giá chung khi lập hoá đơn.

::: tip Giá riêng đè lên giá chung
Giá riêng theo toà (nếu có) luôn **thắng** đơn giá mặc định của dịch vụ. Muốn một toà quay lại dùng giá chung, xoá ô giá riêng của toà đó rồi lưu lại.
:::

**Bước 6**: (tuỳ chọn) chọn một **Định mức** ở ô định mức. Định mức được tạo tại `/settings/categories/service-quotas`.

::: tip Tạo định mức bậc thang
Mở **Cài đặt hệ thống** => **Định mức dịch vụ** và ấn **Thêm**. Đặt tên, thêm các bậc **Từ – Đến – đơn giá**, để trống mốc Đến ở bậc cuối khi muốn áp không giới hạn. Sau khi lưu, mở lại để kiểm tra đủ bậc trước khi gắn vào dịch vụ.
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
| Tạo công tơ báo thiếu dịch vụ dù đã có “DEMO Điện” | Công tơ tra theo tên chính xác **Điện**, **Nước**, **Gas**; tên có tiền tố/hậu tố không khớp. Tạo hoặc giữ ba dịch vụ chuẩn này. |
| Định mức đã lưu nhưng tính bậc thang bị sai / thiếu bậc | Mở lại định mức kiểm tra **đủ số bậc**, các khoảng **Từ – Đến** nối liền nhau và bậc cuối để trống mốc Đến. Sửa lại rồi lưu. |

::: warning Xoá dịch vụ
Xoá dịch vụ chỉ ẩn nó khỏi danh mục, không đụng tới hoá đơn/hợp đồng đã dùng dịch vụ đó. Nhưng dịch vụ đã ẩn sẽ không còn chọn được cho hợp đồng mới — cân nhắc trước khi xoá thay vì chỉ bỏ gán khỏi toà.
:::

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/services" app-label="Mở màn Dịch vụ" fixtures="Snapshot 13/08/2026: DEMO Điện 3.500; DEMO Nước 100.000; DEMO Rác 50.000." view-only>

Mở màn **Dịch vụ** và quan sát ba dòng hiện hành, loại tính tiền, đơn vị, giá và các toà được gán. Không bấm **Thêm/Sửa/Xoá** trong bài chỉ xem.

**Kết quả mong đợi**: bạn phân biệt được dịch vụ cần công tơ với dịch vụ cố định/theo người/theo phòng, và biết một dịch vụ mới phải gắn ít nhất một toà.

</SandboxTry>

## Quy trình liên quan

- [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/) — phải có toà trước mới gán được dịch vụ.
- [Công tơ điện nước](/01-bat-dau/cong-to/) — bước tiếp theo cho các dịch vụ tính theo đồng hồ.
- [Dịch vụ (quản lý vận hành)](/03-quan-ly-van-hanh/dich-vu/) — quản lý dịch vụ trong quá trình vận hành hằng ngày.
