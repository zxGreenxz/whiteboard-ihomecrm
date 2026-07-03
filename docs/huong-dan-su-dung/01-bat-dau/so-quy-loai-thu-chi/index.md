---
title: "Bước 5: Sổ quỹ, tài khoản & loại thu chi"
description: "Tạo sổ quỹ để ghi nhận tiền vào/ra và danh mục loại thu chi để phân loại từng khoản — nền tảng cho mọi phiếu thu, phiếu chi và báo cáo dòng tiền."
routes: ["/finance/cashbooks", "/settings/income-expense-types"]
permissions: [{module: cashbooks, action: create}]
viewport: desktop
audience: [chu-nha, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Bước 5: Sổ quỹ, tài khoản & loại thu chi

Trước khi thu tiền khách hay ghi chi phí vận hành, bạn cần khai báo hai thứ nền tảng: **sổ quỹ** (nơi tiền thực sự nằm — tiền mặt, ngân hàng, ví) và **loại thu chi** (danh mục để phân loại mỗi khoản là "tiền nhà", "tiền điện", "tiền cọc" hay "chi sửa chữa"). Mọi phiếu thu, phiếu chi và mọi báo cáo lợi nhuận/dòng tiền về sau đều dựa vào hai danh mục này. Làm bước này một lần lúc khởi tạo, sau đó chỉ bổ sung khi phát sinh nhu cầu mới.

::: info Điều kiện tiên quyết
- Quyền tạo/sửa **Sổ quỹ** (`cashbooks.create`) — thường là chủ nhà hoặc kế toán.
- Đã có ít nhất một **toà nhà** trong hệ thống (xem [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/)) để gắn toà mặc định cho sổ nếu cần.
- Nắm rõ số dư đầu kỳ thực tế của từng sổ (số tiền đang có trong ví/tài khoản tại ngày bắt đầu dùng phần mềm).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Tài chính** => **Sổ quỹ**. Bạn thấy danh sách các sổ quỹ hiện có kèm số dư từng sổ. Trong dữ liệu demo có ba sổ mẫu: **DEMO Ngân Hàng**, **DEMO Quản Lý Thu** và **DEMO Sale Thu**.

![Màn Sổ quỹ liệt kê DEMO Ngân Hàng, DEMO Quản Lý Thu, DEMO Sale Thu kèm số dư](./images/buoc-01-so-quy.webp)

**Bước 2**: Ấn **Thêm** để mở form tạo sổ quỹ mới. Điền **Tên sổ** — đây là ô quan trọng nhất vì tên quyết định vai trò của sổ (xem hộp mẹo bên dưới về quy ước đặt tên).

**Bước 3**: Điền **Số dư đầu kỳ** và **Ngày chốt đầu kỳ** đúng với thực tế. Hệ thống sẽ lấy con số này làm mốc, rồi cộng/trừ các phiếu thu chi đã duyệt để ra số dư hiện tại. Với sổ ngân hàng, điền thêm **Tên ngân hàng**, **Số tài khoản**, **Chủ tài khoản** để in lên phiếu.

**Bước 4**: Ấn **Lưu**. Sổ mới xuất hiện trong danh sách với số dư bằng đúng số dư đầu kỳ vừa nhập (vì chưa có phiếu nào).

**Bước 5**: Vào **Cài đặt** => **Loại thu chi**. Đây là danh mục hạng mục dùng để phân loại từng dòng tiền. Dữ liệu demo có sẵn các hạng mục như **DEMO Thu Khác** và **DEMO Chi Đặc Biệt**.

![Màn Loại thu chi với hạng mục DEMO Thu Khác và DEMO Chi Đặc Biệt](./images/buoc-02-loai-thu-chi.webp)

**Bước 6**: Ấn **Thêm** để tạo một loại mới. Chọn **Loại** là **Thu** hay **Chi**, điền **Tên hạng mục** và chọn **Nhóm** để gom nhóm khi thống kê. Ấn **Lưu**.

::: tip Quy ước đặt tên sổ để phần mềm tự chọn đúng sổ thu
Sổ có tên **kết thúc bằng "Thu"** (ví dụ **DEMO Quản Lý Thu**, **DEMO Sale Thu**) được hệ thống hiểu là **sổ thu tiền mặt**. Khi bạn thu tiền khách ở màn Thu tiền, phần mềm tự chọn sổ "…Thu" của bạn để ghi nhận. Nếu bạn sở hữu nhiều sổ "…Thu", sổ được đánh dấu **Mặc định** sẽ được ưu tiên chọn. Đặt tên nhất quán ngay từ đầu sẽ tránh cảnh phải đổi sổ thủ công mỗi lần thu.
:::

::: warning Loại cọc phải đánh dấu đúng
Hạng mục dùng cho **tiền cọc** cần được đánh cờ **Cọc** (`is_deposit`). Phần tiền thuộc hạng mục cọc sẽ tự động **bị loại khỏi báo cáo Kết quả kinh doanh** — vì tiền cọc là tiền giữ hộ khách, không phải doanh thu. Nếu quên đánh cờ này, tiền cọc sẽ bị cộng nhầm thành doanh thu và làm sai báo cáo lợi nhuận. Riêng khoản "khách bỏ cọc" (forfeit) thì để cờ Cọc **tắt** vì lúc đó cọc trở thành doanh thu thực.
:::

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| **Số dư đầu kỳ / Ngày chốt** | Mốc khởi điểm của sổ; mọi phiếu đã duyệt cộng/trừ từ mốc này ra số dư hiện tại. |
| **Mặc định** (trên sổ) | Đánh dấu sổ được ưu tiên tự chọn khi bạn có nhiều sổ "…Thu". |
| **Toà nhà mặc định** | Toà tự điền sẵn khi bạn tạo phiếu nhanh từ sổ này. |
| **Khoá sổ** (ngày khoá) | Chặn lập/sửa/xoá phiếu có ngày phát sinh nằm trong kỳ đã chốt sổ. |
| **Người được phép sử dụng** | Chia sẻ sổ cho người khác cùng xem/ghi phiếu, kể cả khi họ không quản lý toà nhà đó. |
| Cờ **Cọc** (loại thu chi) | Đánh dấu hạng mục là tiền cọc → tự loại phần cọc khỏi báo cáo lợi nhuận. |
| Cờ **Hạn chế** (loại thu chi) | Ẩn hạng mục nhạy cảm khỏi nhân viên thiếu quyền (ẩn thật ở tầng dữ liệu). |
| **Nhóm** (loại thu chi) | Gom các hạng mục để thống kê và làm bộ lọc "Nhóm" ở màn Thu chi. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Thu tiền nhưng phần mềm chọn sai sổ | Kiểm tra tên sổ có **kết thúc bằng "Thu"** không; nếu có nhiều sổ "…Thu", đánh dấu **Mặc định** cho sổ muốn ưu tiên. |
| Số dư sổ không khớp thực tế | Rà lại **Số dư đầu kỳ**; nhớ rằng chỉ phiếu đã **duyệt** mới được tính, phiếu nháp/đã huỷ không cộng vào số dư. |
| Tiền cọc bị tính thành doanh thu trong báo cáo | Mở loại thu chi tương ứng, bật cờ **Cọc** để phần cọc tự loại khỏi Kết quả kinh doanh. |
| Không lập được phiếu cho một ngày cũ | Sổ đã bị **khoá** đến ngày đó; chọn sổ khác hoặc điều chỉnh ngày khoá nếu bạn có quyền. |
| Nhân viên không thấy hạng mục nào đó | Hạng mục đang bật cờ **Hạn chế**; cấp quyền tương ứng hoặc tắt cờ nếu không cần ẩn. |
| Đổi cấu hình "Toà mặc định" xong bị mất | Đây là hạn chế đã biết khi sửa sổ; đặt lại toà mặc định và lưu lại nếu thấy bị reset. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/finance/cashbooks" app-label="Mở màn Sổ quỹ" fixtures="DEMO Ngân Hàng, DEMO Quản Lý Thu, DEMO Sale Thu">

1. Ở màn **Sổ quỹ**, xem ba sổ demo: **DEMO Ngân Hàng**, **DEMO Quản Lý Thu**, **DEMO Sale Thu**. Để ý số dư từng sổ và nhận ra hai sổ tên kết thúc "Thu" chính là sổ thu tiền mặt.
2. Chuyển sang **Cài đặt** => **Loại thu chi**. Tìm hai hạng mục mẫu **DEMO Thu Khác** (loại Thu) và **DEMO Chi Đặc Biệt** (loại Chi).

Kết quả mong đợi: bạn hiểu **sổ quỹ = nơi ghi nhận tiền** (mỗi phiếu thu/chi đều rơi vào một sổ), còn **loại thu chi = hạng mục phân loại** từng khoản để lên báo cáo đúng.

</SandboxTry>

## Quy trình liên quan

- [Khởi tạo dữ liệu](/01-bat-dau/khoi-tao-du-lieu/) — bức tranh tổng thể các bước cần làm khi mới bắt đầu.
- [Tạo khu vực & toà nhà](/01-bat-dau/tao-toa-nha/) — có toà nhà trước để gắn toà mặc định cho sổ.
- [Thêm nhân viên & phân quyền](/01-bat-dau/them-nhan-vien/) — cấp quyền thu chi và quyết định ai thấy hạng mục hạn chế.
