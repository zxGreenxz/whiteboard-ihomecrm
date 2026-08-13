---
title: "Trang phòng trống công khai (khách xem)"
description: "Chia sẻ một liên kết /r/:token để khách xem danh sách phòng trống, giá, ảnh, hotline và sơ đồ tầng của toà — không cần đăng nhập; sale đã đăng nhập có thể tạo cọc giữ phòng ngay trên trang."
routes: ["/r/:token", "/phongtrong"]
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Trang phòng trống công khai (khách xem)

Trang **Phòng trống** công khai là một liên kết dạng `https://ptcrm.vercel.app/r/<token>` mà bạn gửi cho khách hoặc cộng tác viên sale để họ tự xem các phòng còn trống của toà — **không cần đăng nhập, không cần tài khoản**. Khách mở link sẽ thấy danh sách phòng trống theo từng toà, giá thuê, ảnh phòng, sơ đồ tầng và nút liên hệ (Gọi / Zalo / Chỉ đường). Bạn tạo và quản lý liên kết này ở trang **Sale Phòng**, còn trang mà bài này mô tả chính là **những gì khách nhìn thấy**. Nếu bạn đang đăng nhập và có quyền, bạn còn có thể **tạo cọc giữ phòng ngay trên trang** để khoá phòng cho khách chỉ bằng một chạm.

::: info Điều kiện tiên quyết
- **Khách xem trang thì không cần quyền gì** — chỉ cần bạn gửi cho họ liên kết `/r/<token>` còn hiệu lực. Liên kết mở với vai trò ẩn danh, không lộ thông tin chủ nhà, hợp đồng hay công nợ.
- Để **tạo và quản lý liên kết chia sẻ**, bạn cần quyền **Sale Phòng => Xem** (module `sale_phong`, action `view`) để mở trang **Sale Phòng**, và quyền **Sale Phòng => Quản lý link chia sẻ** (`manage_tokens`) để tạo / thu hồi liên kết. Xem cách tạo token ở [Sale Phòng](/03-quan-ly-van-hanh/sale-phong/).
- Để **tạo cọc giữ phòng ngay trên trang công khai**, bạn phải **đang đăng nhập** và có quyền **Sale Phòng => Tạo cọc nhanh** (`create_deposit`). Khách ẩn danh không bao giờ thấy nút này.
- Trang chỉ hiện các toà đang có **ít nhất một phòng trống / sắp trống / khách nhờ sale**; toà đã kín phòng sẽ không xuất hiện.
:::

## Tạo liên kết chia sẻ để gửi khách

Trang công khai không tự có sẵn — bạn phải tạo một **token chia sẻ** trước:

1. Vào **Sale Phòng => tab Link chia sẻ**, ấn tạo liên kết mới và đặt một **nhãn** dễ nhớ (ví dụ "Gửi khách khu DEMO A").
2. Hệ thống sinh một chuỗi token ngẫu nhiên và ghép thành liên kết `https://ptcrm.vercel.app/r/<token>`. Ấn **copy** rồi gửi qua Zalo / SMS cho khách.
3. Cùng một chủ nhà có thể tạo **nhiều liên kết** khác nhau (để biết khách đến từ nguồn nào); mọi liên kết đều hiển thị cùng bộ phòng trống của bạn.

Ngoài liên kết có token, hệ thống còn một địa chỉ thương hiệu cố định là **`/phongtrong`** (dùng cho tên miền riêng) — cùng một trang, chỉ khác là token cố định.

::: tip Muốn xem đúng góc nhìn của khách
Sau khi tạo token, hãy mở liên kết `/r/<token>` trong một **tab ẩn danh** (hoặc trình duyệt bạn chưa đăng nhập). Khi đó bạn thấy chính xác những gì khách thấy — không có nút "Tạo cọc giữ phòng", không có ô "Thưởng sale" nội bộ.
:::

## Khách nhìn thấy gì trên trang

Khi mở liên kết, khách thấy một trang tối giản, gọn cho điện thoại:

- **Bộ lọc đầu trang**: các chip chọn **Quận** và chọn **Toà nhà**, cùng một chip **Tổng hợp** để xem gộp tất cả các toà. Con số "trống" trên mỗi thẻ toà/tầng đếm cả phòng **đang trống**, **sắp trống** và **khách nhờ sale**.
- **Hai chế độ xem**:
  - **Danh sách** — mỗi phòng là một thẻ có ảnh, giá thuê, tiện ích; phòng đã thuê được ẩn bớt.
  - **Sơ đồ** — bản vẽ mặt bằng từng tầng theo đúng vị trí phòng; phòng đã thuê hiện mờ để khách hình dung vị trí phòng trống.
- **Chi tiết phòng** (mở từ một phòng): thư viện ảnh, giá thuê / tiền cọc / giá điện, **loại phòng**, thang máy hay thang bộ, ô **Khuyến mãi** (nếu bạn có nhập), và các nút hành động: **Gọi**, **Zalo**, **Chỉ đường**, **Chia sẻ** (gửi kèm toàn bộ ảnh phòng) và **Tải ảnh**.
- **Số liên hệ**: mặc định là **hotline** của bạn; nếu bạn đã đặt số liên hệ riêng cho từng toà thì nút Gọi/Zalo dùng số của toà đó.

Ảnh phòng và ảnh toà hiển thị ở đây được phục vụ từ kho ảnh riêng (Cloudflare R2) cho tải nhanh, không tốn băng thông trang chính.

::: tip Trang tự cập nhật theo thời gian thực "mềm"
Trang tự làm mới sau mỗi vài phút và mỗi khi khách quay lại tab, nên khách luôn thấy tình trạng phòng gần với hiện tại. Khi một phòng vừa được thuê hoặc vừa được đặt cọc giữ chỗ, nó sẽ tự biến mất khỏi danh sách trống ở lần làm mới kế tiếp — bạn không cần sửa gì thủ công.
:::

## Trạng thái phòng hiển thị cho khách

Trang tự tính trạng thái từng phòng dựa trên **hợp đồng thật**, không dựa vào cờ trạng thái thủ công của phòng (vì cờ đó có thể cũ). Có bốn trạng thái:

| Nhãn | Ý nghĩa với khách |
| --- | --- |
| **Trống** | Phòng đang trống thật, sẵn sàng cho thuê. |
| **Sắp trống** | Còn hợp đồng nhưng sắp kết thúc (hoặc khách đã đăng ký chuyển đi) trong khoảng "số ngày báo sắp trống" bạn cấu hình — trang hiện "Dự kiến trống từ …". |
| **Khách nhờ sale** | Phòng đang có khách thuê nhưng khách nhờ bạn tìm người sang lại — hiện chính sách và giá do khách đặt. Có thể hiện **số của khách** hoặc chỉ **"Liên hệ quản lý"** tuỳ khách chọn. |
| **Đã thuê** | Phòng đã có người thuê (hoặc đã được cọc giữ chỗ) — hiện mờ trong sơ đồ, ẩn khỏi danh sách trống. |

Khoảng "sắp trống" (mặc định 30 ngày) và hotline hiển thị được chỉnh trong **Sale Phòng => Cài đặt hiển thị**.

## Tạo cọc giữ phòng ngay trên trang (khi bạn đã đăng nhập)

Nếu bạn — chủ nhà hoặc sale — mở **chính liên kết công khai đó** trong lúc **đang đăng nhập** và có quyền `sale_phong.create_deposit`, bạn sẽ thấy thêm nút **Tạo cọc giữ phòng** ở chi tiết phòng (và có thể chạm thẳng ô phòng xanh ở chế độ Tổng hợp). Đây là cách khoá nhanh một phòng cho khách ngay tại hiện trường:

1. Mở phòng còn trống, ấn **Tạo cọc giữ phòng**.
2. Điền số tiền cọc (có thể để trống nếu chỉ giữ chỗ tạm), ngày vào dự kiến rồi xác nhận.
3. Hệ thống **thử tạo giữ chỗ canonical 24 giờ** trước, sau đó tạo voucher cọc. Hai thao tác là request riêng, không nguyên tử; nếu writer giữ chỗ, quyền hoặc hạ tầng không sẵn sàng, luồng có thể tiếp tục tạo voucher mà không khoá phòng.
4. Số tiền để trống hoặc **1đ** dùng tài khoản ảo **CỌC**; số tiền lớn hơn 1 dùng sổ quỹ thật mặc định của nhân viên khi tìm thấy. Voucher mới có thể còn chờ duyệt/chưa post, nên hãy kiểm tra trạng thái và phòng sau khi tạo.

::: danger Không coi việc bấm nút là bằng chứng đã thu tiền hoặc đã khoá phòng
`APPROVED + UNPOSTED` vẫn chưa làm tiền vào sổ; chỉ voucher `POSTED` trên một sổ quỹ thật mới chứng minh đã thu tiền. Giữ chỗ 24 giờ là nỗ lực best-effort và có thể fail-open, nên sau khi xác nhận hãy mở [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) hoặc [Thu chi](/03-quan-ly-van-hanh/thu-chi/) để kiểm trạng thái, đồng thời tải lại trang để chắc phòng đã biến khỏi danh sách. Khoản cọc được ghi riêng và **không tính vào KQKD**.
:::

::: warning Voucher cọc và giữ chỗ là hai bản ghi riêng
Trang công khai chỉ **tạo**, không có nút gỡ. Vì voucher và giữ chỗ không cùng một giao dịch, huỷ một bên chưa chắc tự huỷ bên kia. Khi khách đổi ý, xử lý voucher ở [Thu chi](/03-quan-ly-van-hanh/thu-chi/) hoặc [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/), rồi kiểm tra lại trạng thái/giữ chỗ của phòng trước khi mở bán.
:::

## Đo đếm lượt xem của khách

Mọi thao tác của khách trên trang — mở trang, thời gian xem, phòng nào được hiện ra / mở chi tiết, bấm Gọi / Zalo / Chia sẻ / Tải ảnh — đều được **ghi nhận ẩn danh**. Bạn xem báo cáo này ở **Sale Phòng => tab Thống kê**: tổng quan lượt truy cập, phòng được xem nhiều nhất, xu hướng theo thời gian, theo từng liên kết chia sẻ, và cả lỗi phát sinh. Có công tắc **loại trừ lượt xem nội bộ** để không tính những lần chính nhân viên mở trang.

## Các tính năng khác

| Nút / khu vực | Công dụng |
| --- | --- |
| Chip **Quận** / **Toà nhà** | Lọc nhanh phòng theo quận hoặc theo từng toà. |
| Chip **Tổng hợp** | Xem gộp tất cả các toà trong một màn, mỗi toà một thẻ tóm tắt. |
| Chuyển **Danh sách / Sơ đồ** | Đổi giữa xem thẻ phòng và xem mặt bằng từng tầng. |
| **Gọi / Zalo** | Liên hệ theo số của toà (nếu có) hoặc hotline chung; với phòng khách nhờ sale là số khách hoặc "Liên hệ quản lý". |
| **Chỉ đường** | Mở Google Maps tới địa chỉ toà. |
| **Chia sẻ** | Gửi thông tin phòng kèm **toàn bộ ảnh** qua trình chia sẻ của điện thoại; máy không hỗ trợ thì sao chép nội dung. |
| **Tải ảnh** | Lưu toàn bộ ảnh của phòng về máy. |
| **Tạo cọc giữ phòng** | Chỉ hiện khi bạn đăng nhập + có quyền `create_deposit` — khoá phòng bằng một phiếu cọc. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Khách mở link báo **"Liên kết không hợp lệ hoặc đã hết hạn"** | Liên kết đã bị **thu hồi** hoặc gõ sai token. Vào **Sale Phòng => Link chia sẻ** để khôi phục liên kết đã thu hồi hoặc tạo liên kết mới rồi gửi lại. |
| **Không thấy toà nào** trên trang | Trang chỉ hiện toà có ít nhất một phòng **trống / sắp trống / khách nhờ sale**. Toà đã kín phòng sẽ không xuất hiện — đúng thiết kế. |
| Thấy vài toà **lạ** hoặc dữ liệu mẫu | Khi mở trang mà **không có token hợp lệ**, trang rơi về **dữ liệu mẫu** để xem thử giao diện. Hãy mở đúng liên kết `/r/<token>` bạn đã tạo. |
| Muốn **gỡ một liên kết** đã lỡ gửi | Ở **Sale Phòng => Link chia sẻ**, dùng **Thu hồi** (khách hết xem được ngay, vẫn khôi phục được sau). Chỉ **Xoá** khi muốn mất hẳn — không lấy lại được. |
| **Không thấy nút "Tạo cọc giữ phòng"** dù đang đăng nhập | Bạn thiếu quyền **Sale Phòng => Tạo cọc nhanh** (`create_deposit`), hoặc đang mở trang ở tab chưa đăng nhập. Nhờ quản trị cấp quyền — xem [Phân quyền](/05-cai-dat/phan-quyen/). |
| Phòng vừa cọc **vẫn còn** trên link của khách | Trang làm mới sau vài phút; bảo khách tải lại trang. Phòng đã cọc giữ chỗ sẽ tự ẩn ở lần làm mới kế tiếp. |
| Số liên hệ hiển thị **sai** | Đặt số riêng cho từng toà trong **Sale Phòng => Thông tin sale**, hoặc chỉnh hotline chung ở [Hotline](/05-cai-dat/hotline/). |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.sale" app-path="/sale-phong" app-label="Mở trang Sale Phòng" view-only>

Trang công khai cần một token chia sẻ, nên hãy bắt đầu từ trang **Sale Phòng** rồi mở link ở tab ẩn danh để thấy đúng góc nhìn khách:

1. Vào **Sale Phòng => tab Link chia sẻ**, tạo một liên kết mới cho các toà **DEMO A** / **DEMO B** và **copy** đường link `/r/<token>`.
2. Mở link đó trong một **tab ẩn danh** (không đăng nhập) — bạn sẽ thấy danh sách phòng trống của Tòa DEMO A và DEMO B, thử chuyển giữa **Danh sách** và **Sơ đồ**, và mở chi tiết một phòng.
3. Quay lại tab đã đăng nhập, sang **tab Thống kê** để thấy lượt xem vừa rồi được ghi nhận.

Đây là bản xem thử: bạn duyệt được luồng nhưng không ghi thay đổi thật. Trên bản thật, nếu mở chính link đó khi đã đăng nhập và có quyền, bạn sẽ thấy thêm nút **Tạo cọc giữ phòng**.

</SandboxTry>

## Quy trình liên quan

- [Sale Phòng](/03-quan-ly-van-hanh/sale-phong/) — nơi tạo liên kết chia sẻ, cấu hình hiển thị, ảnh sale, sơ đồ tầng và xem thống kê lượt truy cập.
- [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) — bổ sung và quản lý tiền cọc sau khi tạo cọc giữ phòng trên trang công khai.
- [Thu tiền tại phòng (điện thoại)](/03-quan-ly-van-hanh/thu-tien-mobile/) — công cụ cầm tay đi thu tiền hoá đơn, cùng họ với các màn ngoài hiện trường.
- [Hotline](/05-cai-dat/hotline/) — cấu hình số hotline mặc định hiển thị trên trang công khai.
- [Phân quyền](/05-cai-dat/phan-quyen/) — cấp quyền `sale_phong.view`, `manage_tokens`, `create_deposit` cho nhân viên.
- [Căn hộ & phòng](/03-quan-ly-van-hanh/can-ho-phong/) — quản lý phòng, giá thuê và trạng thái phòng làm nguồn cho trang công khai.
