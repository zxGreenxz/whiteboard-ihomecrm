---
title: "Định mức dịch vụ"
description: "Tạo bảng giá bậc thang (luỹ tiến) cho dịch vụ — khai từng bậc Từ – Đến – Đơn giá rồi gắn định mức vào dịch vụ tính theo đồng hồ."
routes: ["/settings/categories/service-quotas"]
permissions: [{module: service_quotas, action: view}, {module: service_quotas, action: create}, {module: service_quotas, action: edit}, {module: service_quotas, action: delete}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-08-13"
  account: demo
status: published
---

# Định mức dịch vụ

Định mức dịch vụ là **bảng giá bậc thang (luỹ tiến)** dùng cho các dịch vụ có đơn giá thay đổi theo mức tiêu thụ — điển hình là điện luỹ tiến (dùng càng nhiều, đơn giá bậc sau càng cao). Mỗi định mức gồm nhiều **bậc**, mỗi bậc là một khoảng sản lượng **Từ – Đến** kèm **đơn giá** áp trong khoảng đó. Bạn tạo định mức một lần ở màn này, sau đó **gắn nó vào một hoặc nhiều dịch vụ** — khi lập hoá đơn, hệ thống lấy sản lượng đọc từ công tơ, chiếu vào bậc tương ứng và tính ra tiền. Dùng màn này khi cần khai giá điện/nước luỹ tiến hoặc khi phải chỉnh lại các mốc bậc.

::: info Điều kiện tiên quyết
- Quyền **Định mức dịch vụ => Xem** (module `service_quotas`, action `view`) để mở danh sách.
- Quyền **Thêm / Sửa / Xoá** trên định mức nếu muốn tạo hoặc chỉnh các bậc giá.
- Để định mức thực sự ra tiền: cần có **dịch vụ** gắn định mức này (tại trang [Dịch vụ](/03-quan-ly-van-hanh/dich-vu/)) và phòng đã có **công tơ** ghi chỉ số (xem [Công tơ điện nước](/01-bat-dau/cong-to/)).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt** => **Định mức dịch vụ**. Màn hiện danh sách các định mức đã tạo, mỗi dòng là một định mức kèm **Tên** và **Mô tả**.

**Bước 2**: Ấn nút **Thêm** để tạo một định mức mới. Nhập **Tên định mức** (ví dụ "Điện luỹ tiến") và **Mô tả** (tuỳ chọn) để dễ nhận biết khi gắn vào dịch vụ.

**Bước 3**: Thêm các **bậc** cho định mức. Mỗi bậc gồm ba ô:

| Ô nhập | Ý nghĩa |
| --- | --- |
| **Từ** | Mốc đầu của khoảng sản lượng áp bậc này. Bậc đầu tiên thường bắt đầu từ **0**. |
| **Đến** | Mốc cuối của khoảng. Áp cho sản lượng **nhỏ hơn** mốc này. **Bậc cuối cùng để trống ô Đến** nghĩa là vô cực — áp cho mọi lượng vượt các bậc trước. |
| **Đơn giá** | Giá cho mỗi đơn vị (Kwh, m³...) khi sản lượng rơi vào khoảng của bậc. |

Ấn thêm dòng để có nhiều bậc; các khoảng **Từ – Đến** nên **nối liền nhau** (mốc **Đến** của bậc trước bằng mốc **Từ** của bậc sau) để không bị "hụt" khoảng nào.

**Bước 4**: Hiểu cách bậc thang ra tiền: sản lượng của phòng (chỉ số mới − chỉ số cũ) được chiếu vào bậc chứa nó, rồi áp **đơn giá** của bậc đó. Ví dụ định mức "Điện luỹ tiến":

| Bậc | Từ | Đến | Đơn giá |
| --- | --- | --- | --- |
| 1 | 0 | 50 | 3.000đ / Kwh |
| 2 | 50 | 100 | 3.500đ / Kwh |
| 3 | 100 | *(để trống)* | 4.000đ / Kwh |

**Bước 5**: Ấn **Lưu**. Định mức mới xuất hiện trong danh sách và sẵn sàng để gắn vào dịch vụ.

**Bước 6**: Gắn định mức vào dịch vụ. Sang trang [Dịch vụ](/03-quan-ly-van-hanh/dich-vu/), mở **Sửa** một dịch vụ tính theo đồng hồ (ví dụ điện), chọn định mức vừa tạo ở ô **Định mức**, rồi lưu lại. Một định mức có thể dùng cho **nhiều dịch vụ**.

**Bước 7**: Muốn chỉnh giá, ấn **Sửa** trên dòng định mức để sửa tên, mô tả hoặc từng bậc; ấn **Xoá** để gỡ định mức không dùng nữa.

::: warning Sửa bậc ảnh hưởng cách tính hoá đơn
Định mức là bảng giá dùng chung — chỉnh **Từ / Đến / Đơn giá** của một bậc sẽ đổi số tiền của **mọi dịch vụ** đang gắn định mức đó ở các hoá đơn lập **sau khi sửa**. Trước khi lưu, kiểm tra lại **đủ số bậc**, các khoảng nối liền nhau và bậc cuối để trống ô **Đến**. Định mức bị thiếu bậc (do lưu lỗi trước đó) khiến dịch vụ tính bậc thang ra tiền sai hoặc bằng 0.
:::

## Các tính năng khác trên màn hình

| Nút / Thành phần | Công dụng |
| --- | --- |
| Nút **Thêm** | Mở form tạo một định mức mới kèm các bậc. |
| Nút **Sửa** | Mở lại form để chỉnh tên, mô tả và từng bậc của định mức. |
| Nút **Xoá** | Ẩn định mức khỏi danh sách (xoá mềm); không đụng tới hoá đơn cũ đã tính bằng định mức này. |
| Ô **Tên định mức** / **Mô tả** | Đặt tên và ghi chú để nhận biết định mức khi gắn vào dịch vụ. |
| Các ô **Từ** / **Đến** / **Đơn giá** | Khai từng bậc của bảng giá; bậc cuối để trống **Đến** là vô cực. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Dịch vụ tính bậc thang ra tiền **sai** hoặc **bằng 0** | Mở lại định mức, kiểm tra **đủ số bậc**, các khoảng **Từ – Đến** nối liền nhau và bậc cuối để trống ô **Đến**. Nếu định mức bị mất bậc, khai lại rồi lưu. |
| Đã tạo định mức nhưng hoá đơn không áp giá luỹ tiến | Định mức chưa được **gắn vào dịch vụ**. Sang [Dịch vụ](/03-quan-ly-van-hanh/dich-vu/), mở **Sửa** dịch vụ và chọn định mức ở ô **Định mức**. |
| Gắn định mức rồi mà hoá đơn vẫn không có sản lượng | Dịch vụ bậc thang cần **công tơ** đặt tại phòng và có ghi chỉ số. Xem [Công tơ điện nước](/01-bat-dau/cong-to/) và [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/). |
| Có khoảng sản lượng không rơi vào bậc nào | Các bậc bị "hụt" khoảng. Chỉnh mốc **Đến** của bậc trước bằng mốc **Từ** của bậc sau để các khoảng nối liền, và để trống **Đến** ở bậc cuối. |
| Sửa đơn giá định mức nhưng hoá đơn cũ không đổi | Đúng như thiết kế — thay đổi chỉ áp cho hoá đơn lập **sau khi sửa**; hoá đơn đã lập giữ nguyên số liệu tại thời điểm lập. |
| Danh sách trống dù chắc chắn đã tạo định mức | Thường do quyền: kiểm tra lại quyền **Định mức dịch vụ => Xem** hoặc nhờ quản lý cấp quyền. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/settings/categories/service-quotas" app-label="Mở màn Định mức dịch vụ" view-only>

Xem định mức bậc thang (nếu có):

1. Vào **Cài đặt** => **Định mức dịch vụ** để xem danh sách các định mức đã khai.
2. Nếu có định mức bậc thang (ví dụ điện luỹ tiến), ấn **Sửa** để mở và đọc từng **bậc**: chú ý mốc **Từ**, mốc **Đến** và **Đơn giá** của mỗi bậc.
3. Để ý **bậc cuối cùng để trống ô Đến** — đó là bậc vô cực, áp cho mọi lượng tiêu thụ vượt các bậc trước.

Kết quả mong đợi: bạn hiểu một định mức được ghép từ nhiều bậc **Từ – Đến – Đơn giá** nối liền nhau, và hình dung được cách sản lượng của phòng chiếu vào bậc để ra tiền trên hoá đơn.

</SandboxTry>

## Quy trình liên quan

- [Dịch vụ](/03-quan-ly-van-hanh/dich-vu/) — nơi gắn định mức vào một dịch vụ tính theo đồng hồ.
- [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/) — khai lần đầu dịch vụ và định mức khi khởi tạo hệ thống.
- [Công tơ điện nước](/01-bat-dau/cong-to/) — tạo công tơ cho phòng để có sản lượng áp bậc thang.
- [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) — nhập chỉ số công tơ hằng tháng, nguồn sản lượng để tính giá luỹ tiến.
