---
title: "Tài khoản ngân hàng / sổ quỹ"
description: "Danh mục tài khoản ngân hàng: khai báo sổ ngân hàng, thông tin tài khoản, số dư đầu kỳ và sổ mặc định để ghi nhận dòng tiền."
routes: ["/settings/categories/bank-accounts"]
permissions: [{module: categories, action: view}]
viewport: desktop
audience: [chu-nha, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Tài khoản ngân hàng / sổ quỹ

Trong phần mềm, mỗi tài khoản ngân hàng của bạn được khai báo dưới dạng một **sổ quỹ ngân hàng** — nơi ghi nhận tiền vào/ra qua chuyển khoản, kèm **thông tin ngân hàng** (tên ngân hàng, số tài khoản, chủ tài khoản) để in lên phiếu, **số dư đầu kỳ** làm mốc tính tồn quỹ, và tuỳ chọn đặt làm **sổ mặc định**. Trang này là **màn danh mục** giúp bạn nắm cách quản lý các tài khoản ngân hàng đó. Việc thêm/sửa sổ hiện được thực hiện chung ở màn **Sổ quỹ** — xem thêm trang vận hành [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/).

::: info Điều kiện tiên quyết
- Quyền xem **Danh mục** (`categories.view`) để mở màn Tài khoản ngân hàng trong Cài đặt.
- Quyền tạo/sửa **Sổ quỹ** (`cashbooks.create`) để thực sự thêm hoặc sửa sổ ngân hàng — thường là chủ nhà hoặc kế toán.
- Nắm rõ số dư thực tế của từng tài khoản ngân hàng tại ngày bắt đầu dùng phần mềm (để khai **Số dư đầu kỳ** cho đúng).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Cài đặt hệ thống** => **Danh mục khác** => **Tài khoản ngân hàng**. Đây là mục danh mục dành riêng cho tài khoản ngân hàng. Hiện màn hình hiển thị thông báo **Tính năng đang phát triển** — bảng danh mục ngân hàng chuyên biệt sẽ sớm được hoàn thiện; trong thời gian đó, bạn quản lý tài khoản ngân hàng ngay tại màn **Sổ quỹ** như hướng dẫn bên dưới.

![Màn hình](./images/buoc-01-man-hinh.webp)

**Bước 2**: Mở màn quản lý sổ: vào **Tài chính** => **Sổ quỹ**. Bạn thấy danh sách các sổ quỹ hiện có kèm số dư. Trong dữ liệu demo có ba sổ mẫu: **DEMO Ngân Hàng** (sổ tài khoản ngân hàng), **DEMO Quản Lý Thu** và **DEMO Sale Thu** (hai sổ thu tiền mặt).

**Bước 3**: Ấn **Thêm** để mở form tạo sổ mới, rồi điền **Tên sổ**. Với một tài khoản ngân hàng, hãy đặt tên dễ nhận biết (ví dụ **DEMO Ngân Hàng**) và điền tiếp khối thông tin ngân hàng: **Tên ngân hàng**, **Số tài khoản**, **Chủ tài khoản** và **Chi nhánh** (nếu có). Những thông tin này sẽ được in lên phiếu thu/chi liên quan đến tài khoản.

**Bước 4**: Điền **Số dư đầu kỳ** và **Ngày chốt đầu kỳ** đúng với số dư thực tế của tài khoản ngân hàng tại thời điểm bắt đầu dùng phần mềm. Ví dụ, nếu tài khoản đang có **1.000.000đ**, hãy khai đúng **1.000.000đ**. Hệ thống lấy con số này làm mốc rồi cộng/trừ các phiếu đã duyệt để ra **Tồn quỹ** hiện tại — bạn không chỉnh tồn quỹ bằng tay.

**Bước 5**: Nếu tài khoản này là nơi bạn muốn phần mềm ưu tiên chọn khi ghi nhận chuyển khoản, đánh dấu **Mặc định**. Xong ấn **Lưu**. Sổ ngân hàng mới xuất hiện trong danh sách với tồn quỹ bằng đúng số dư đầu kỳ vừa nhập (vì chưa có phiếu nào).

::: danger Số dư đầu kỳ là con số ghi tiền — khai đúng ngay từ đầu
**Số dư đầu kỳ** là mốc để hệ thống tính **Tồn quỹ** của tài khoản ngân hàng. Khai sai (thừa/thiếu) sẽ làm lệch toàn bộ số dư và mọi báo cáo dòng tiền của sổ này. Chỉ nhập số dư thực tế tại ngày chốt đầu kỳ; **không** chỉnh số dư đầu kỳ về sau chỉ để "cho khớp" tồn quỹ — muốn số dư thay đổi thì phải ghi phiếu thu/chi thật, không sửa mốc đầu kỳ.
:::

::: warning Đổi tên sổ ngân hàng có thể gãy tự động chọn sổ
Phần mềm nhận diện một số sổ đặc biệt **theo tên** (sổ kết thúc bằng "Thu", sổ "Chung", sổ "Làm tròn tiền thiếu", sổ trùng tên toà). Nếu tài khoản ngân hàng của bạn đang được dùng làm sổ mặc định thu tiền chuyển khoản của một toà, việc **đổi tên** sổ sau khi đã cấu hình có thể khiến các phiên thu tiền chọn nhầm sổ và **khó phát hiện**. Rà kỹ trước khi đổi tên các sổ đang được dùng.
:::

## Các tính năng khác trên màn hình

| Nút / Trường | Công dụng |
| --- | --- |
| **Quay lại Danh mục khác** | Trở về trang Danh mục khác chứa các mục cài đặt danh mục. |
| **Tên sổ** (form Sổ quỹ) | Tên tài khoản ngân hàng hiển thị trong danh sách và mọi ô chọn sổ. |
| **Tên ngân hàng / Số tài khoản / Chủ tài khoản / Chi nhánh** | Thông tin ngân hàng in lên phiếu thu/chi của tài khoản. |
| **Số dư đầu kỳ / Ngày chốt đầu kỳ** | Mốc khởi điểm; mọi phiếu đã duyệt cộng/trừ từ mốc này ra Tồn quỹ. |
| **Mặc định** | Đánh dấu sổ được ưu tiên tự chọn khi ghi nhận tiền. |
| **Phụ trách** | Người chịu trách nhiệm sổ (chỉ admin đổi được người phụ trách). |
| **Người được phép sử dụng** | Chia sẻ sổ cho người khác cùng xem/ghi phiếu, kể cả khi họ không quản lý toà nhà gắn với sổ. |
| **Khoá sổ** | Đặt ngày khoá; chặn lập/sửa/xoá phiếu có ngày phát sinh trong kỳ đã chốt. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Màn **Tài khoản ngân hàng** báo "đang phát triển" | Đúng như hiện trạng; quản lý tài khoản ngân hàng tạm thời làm ở màn **Sổ quỹ** (Tài chính => Sổ quỹ). |
| Không thấy nút **Thêm** ở màn Sổ quỹ | Bạn thiếu quyền tạo/sửa **Sổ quỹ** (`cashbooks.create`); nhờ chủ nhà hoặc admin cấp quyền. |
| Tồn quỹ tài khoản không khớp sao kê ngân hàng | Nhớ rằng chỉ phiếu **đã duyệt** mới tính; rà lại **Số dư đầu kỳ** và loại các phiếu **nháp** / **đã huỷ** khỏi phép cộng. |
| Thông tin ngân hàng không hiện trên phiếu in | Kiểm tra đã điền đủ **Tên ngân hàng / Số tài khoản / Chủ tài khoản** trong form sổ và đã **Lưu**. |
| Không lập được phiếu cho một ngày cũ trên sổ ngân hàng | Sổ đã bị **khoá** tới ngày đó; mở khoá (nếu có quyền) hoặc chọn ngày phát sinh sau ngày khoá. |
| Đổi tên sổ ngân hàng xong hệ thống chọn sai sổ khi thu chuyển khoản | Phần mềm nhận diện sổ theo **tên**; hoàn tên cũ hoặc rà lại cấu hình sổ mặc định của toà trước khi đổi. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/settings/categories/bank-accounts" app-label="Mở màn Tài khoản ngân hàng" fixtures="3 sổ demo">

1. Mở màn **Tài khoản ngân hàng** (Cài đặt hệ thống => Danh mục khác => Tài khoản ngân hàng) và đọc thông báo **Tính năng đang phát triển** — ghi nhớ rằng việc quản lý tài khoản ngân hàng hiện làm ở màn Sổ quỹ.
2. Vào **Tài chính** => **Sổ quỹ**, xem **3 sổ demo**: **DEMO Ngân Hàng**, **DEMO Quản Lý Thu**, **DEMO Sale Thu**. Nhận ra **DEMO Ngân Hàng** chính là một tài khoản ngân hàng đã khai.
3. Ấn **Thêm**, tạo thử một sổ ngân hàng mới: điền **Tên sổ**, **Tên ngân hàng**, **Số tài khoản**, **Chủ tài khoản**, đặt **Số dư đầu kỳ** = **1.000.000đ**, rồi **Lưu**. Kiểm tra sổ mới có Tồn quỹ bằng đúng **1.000.000đ**.
4. Xong bài, ấn **Reset** để trả sandbox về dữ liệu ban đầu.

Kết quả mong đợi: bạn hiểu **tài khoản ngân hàng = một sổ quỹ ngân hàng** — khai thông tin ngân hàng và số dư đầu kỳ đúng thì mọi phiếu chuyển khoản và báo cáo dòng tiền của sổ sẽ chính xác.

</SandboxTry>

## Quy trình liên quan

- [Sổ quỹ (vận hành)](/03-quan-ly-van-hanh/so-quy/) — xem giao dịch, tồn quỹ, chia sẻ sổ và các sổ ảo tiền thối/làm tròn/cấn trừ.
- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — tạo sổ mới, đặt số dư đầu kỳ và quy ước đặt tên sổ.
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/) — lập/sửa/huỷ từng phiếu thu, phiếu chi làm thay đổi số dư sổ ngân hàng.
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — thu tiền khách qua chuyển khoản tạo phiếu thu rơi vào sổ ngân hàng.
