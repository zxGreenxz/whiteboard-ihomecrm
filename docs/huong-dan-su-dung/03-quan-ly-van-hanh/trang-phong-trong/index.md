---
title: "Trang phòng trống công khai (khách xem)"
description: "Chia sẻ một liên kết /r/:token để khách xem danh sách phòng trống, giá, ảnh, hotline và sơ đồ tầng của toà — không cần đăng nhập; người đã đăng nhập có quyền có thể nhận cọc giữ phòng hoặc Lock tạm ngay trên trang."
routes: ["/r/:token", "/phongtrong"]
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-10-07"
  commit: "81c5a3cdf03740321061db919a40991c772bd4b4"
  account: demo.chunha
status: published
---

# Trang phòng trống công khai (khách xem)

Trang **Phòng trống** công khai là một liên kết dạng `https://ptcrm.vercel.app/r/<token>` mà bạn gửi cho khách hoặc cộng tác viên sale để họ tự xem các phòng còn trống — **không cần đăng nhập, không cần tài khoản**. Khách mở link sẽ thấy danh sách phòng trống theo từng toà, giá thuê, ảnh phòng, sơ đồ tầng và nút liên hệ (Gọi / Zalo / Chỉ đường). Bạn tạo và quản lý liên kết này ở trang [Sale Phòng](/03-quan-ly-van-hanh/sale-phong/), còn bài này mô tả **những gì khách nhìn thấy**. Nếu bạn đang đăng nhập và có quyền, bạn còn có thể **nhận cọc giữ phòng** hoặc **Lock tạm** phòng ngay trên trang.

::: info Điều kiện tiên quyết
- **Khách xem trang thì không cần quyền gì** — chỉ cần liên kết `/r/<token>` còn hiệu lực. Liên kết mở với vai trò ẩn danh, không lộ thông tin chủ nhà, hợp đồng hay công nợ.
- Để **tạo và quản lý liên kết chia sẻ**, bạn cần quyền **Sale Phòng => Xem** (`sale_phong.view`) và **Quản lý link chia sẻ** (`manage_tokens`). Xem cách tạo ở [Sale Phòng](/03-quan-ly-van-hanh/sale-phong/).
- Để **nhận cọc giữ phòng ngay trên trang công khai**, bạn phải **đang đăng nhập** và có quyền **Sale Phòng => Tạo cọc nhanh** (`create_deposit`). Khách ẩn danh không bao giờ thấy nút này.
- Để **Lock tạm** phòng, bạn cần quyền **Sale Phòng => Lock tạm phòng** (`sale_phong.lock_room`). Mặc định chỉ vai Chủ sở hữu tổ chức có quyền này; chủ tự gán thêm cho người cần trong [Phân quyền](/05-cai-dat/phan-quyen/).
- Trang chỉ hiện các toà đang có **ít nhất một phòng trống / sắp trống / khách nhờ sale**; toà đã kín phòng sẽ không xuất hiện.
:::

::: tip Bài này không kèm ảnh chụp
Tài khoản DEMO chưa có link chia sẻ nào, còn địa chỉ thương hiệu `/phongtrong` hiển thị phòng thật của công ty, nên bài chỉ mô tả bằng chữ. Muốn xem tận mắt, hãy tạo một link ở **Sale Phòng** rồi mở nó trong tab ẩn danh.
:::

## Tạo liên kết chia sẻ để gửi khách

Trang công khai không tự có sẵn — bạn phải tạo một **token chia sẻ** trước:

1. Vào **Sale Phòng => tab Link chia sẻ**, ấn **Tạo link mới** và đặt một **nhãn** dễ nhớ (ví dụ "Gửi khách khu Gò Vấp").
2. Hệ thống sinh token ngẫu nhiên và ghép thành liên kết `https://ptcrm.vercel.app/r/<token>`. Ấn **Copy link** rồi gửi qua Zalo / SMS cho khách.
3. Bạn có thể tạo **nhiều liên kết** khác nhau (để biết khách đến từ nguồn nào); mọi liên kết đều hiển thị cùng bộ phòng trống của bạn.

Ngoài liên kết có token, hệ thống còn một địa chỉ thương hiệu cố định là **`/phongtrong`** (dùng cho tên miền riêng) — cùng một trang, chỉ khác là token cố định.

::: tip Muốn xem đúng góc nhìn của khách
Mở liên kết `/r/<token>` trong một **tab ẩn danh** (hoặc trình duyệt chưa đăng nhập). Khi đó bạn thấy chính xác những gì khách thấy — không có nút **Tạo cọc giữ phòng**, không có dòng **Thưởng sale** nội bộ.
:::

## Khách nhìn thấy gì trên trang

Khi mở liên kết, khách thấy một trang gọn cho điện thoại:

- **Đầu trang**: tiêu đề **Phòng trống**, nút **Tải ảnh** (xuất một ảnh bảng danh sách phòng trống để gửi Zalo) và chấm **Live · giờ cập nhật**.
- **Hai chế độ xem**: **Danh sách** (thẻ toà, mỗi phòng là một thẻ có ảnh, giá, tiện ích) và **Sơ đồ** (mặt bằng từng tầng theo đúng vị trí phòng; phòng đã thuê hiện mờ).
- **Bộ lọc**: hàng chip **Quận** (Tất cả / từng quận), hàng **Tòa nhà** (chip **Tổng hợp** xem gộp mọi toà kèm số toà và số phòng trống, rồi từng toà kèm quận và số trống), hàng **Khoảng giá** (`Mọi giá`, `< 4tr`, `4–5tr`, `> 5tr`).
- **Thẻ toà**: tên toà, số phòng trống, địa chỉ, người liên hệ quản lý kèm nút **Zalo** và số điện thoại, các ô phòng nhanh dạng "số phòng · giá".
- **Chi tiết phòng** (mở từ một phòng): giá (triệu/tháng), nhãn tình trạng, thư viện ảnh, diện tích, **Loại phòng**, nội thất, **Khuyến mãi** (nếu có) và các nút **Tải ảnh**, **Chỉ đường**, **Chia sẻ** (gửi kèm toàn bộ ảnh phòng), **Gọi Quản Lý** (hoặc **Gọi khách** với phòng khách nhờ sale), **Zalo**.
- **Số liên hệ**: dùng **Liên hệ quản lý toà** đã nhập ở **Sale Phòng => Thông tin sale**; toà chưa có thì dùng **hotline** chọn ở **Cài đặt hiển thị**. Không có số nào thì nút hiện **Chưa có số liên hệ**.

::: tip Trang tự cập nhật
Khi tab đang mở, trang tự tải lại dữ liệu mỗi vài giây (giãn dần tới 1 phút nếu mạng lỗi) và dừng khi tab bị ẩn. Phòng vừa được thuê hoặc vừa được giữ chỗ sẽ tự đổi trạng thái ở lần làm mới kế tiếp — bạn không cần sửa gì thủ công.
:::

## Trạng thái phòng hiển thị cho khách

Trang tự tính trạng thái từng phòng dựa trên **hợp đồng thật, báo trả phòng, giữ chỗ và lịch dọn/sửa**, không dựa vào công tắc trạng thái thủ công của phòng:

| Nhãn | Ý nghĩa với khách |
| --- | --- |
| **Trống sẵn** | Phòng đang trống thật, sẵn sàng cho thuê. |
| **Đang chuẩn bị · dự kiến dd/mm/yyyy** | Phòng trống nhưng đang dọn/sửa; nếu chưa có ngày thì ghi "chưa có ngày dự kiến", nếu ngày dự kiến đã qua thì ghi "cần xác nhận ngày sẵn sàng". |
| **Sắp trống · dd/mm/yyyy** | Còn hợp đồng nhưng sắp kết thúc hoặc khách đã báo trả, trong khoảng "Số ngày báo sắp trống" bạn cấu hình. |
| **Cần xác nhận ngày trống** | Khách đã báo trả nhưng ngày trống dự kiến đã qua mà chưa ghi nhận trả phòng thật. |
| **Khách pass phòng** | Phòng đang có khách thuê nhưng khách nhờ tìm người sang lại — hiện chính sách và giá do khách đặt, số của khách hoặc chỉ "Liên hệ quản lý" tuỳ khách chọn. |
| **Đã thuê / giữ chỗ** | Phòng đã có người thuê hoặc đã được giữ chỗ — hiện mờ trong sơ đồ, ẩn khỏi danh sách trống. |
| **Đã chốt tạm** (chỉ nhân viên đăng nhập thấy) | Phòng đang bị Lock tạm. Khách mở link công khai không thấy phòng này; xem mục "Lock tạm phòng" bên dưới. |

Khoảng "sắp trống" (mặc định 30 ngày) và hotline hiển thị được chỉnh trong **Sale Phòng => Cài đặt hiển thị**.

## Nhận cọc giữ phòng ngay trên trang (khi bạn đã đăng nhập)

Nếu bạn — chủ nhà hoặc sale — mở **chính liên kết công khai đó** trong lúc **đang đăng nhập** và có quyền `sale_phong.create_deposit`, bạn sẽ thấy thêm nút **Tạo cọc giữ phòng** ở chi tiết phòng (phòng chưa thuê) và có thể chạm thẳng ô phòng trống ở chế độ **Tổng hợp**. Hộp thoại **Nhận cọc giữ phòng** mở ra:

1. Ô **Khách hàng \***: ấn **Danh bạ** để chọn khách có sẵn, **hoặc** gõ một **tên khách gợi nhớ** (tối đa 120 ký tự, ví dụ "anh Tuấn xem phòng 18h") — không cần tạo khách mới.
2. Nhập **Số tiền cọc** (phải lớn hơn 0) và chọn **Sổ quỹ nhận cọc** (mặc định sổ quỹ mặc định của chính bạn).
3. Tuỳ chọn **Giữ chỗ đến**, **Ngày dự kiến vào** và **Ngày bổ sung cọc**.
4. Ấn **Lưu cọc & giữ phòng**.

Hộp thoại không còn lựa chọn **Giữ chỗ 0 đồng**. Muốn giữ phòng mà chưa thu tiền, dùng **Lock tạm** (mục bên dưới). Giữ chỗ 0 đồng đã tạo từ trước vẫn còn hiệu lực và vẫn hiện trong [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/).

Giữ chỗ và phiếu cọc nguồn được tạo **trong cùng một lần ghi** ở máy chủ: thành công thì trang báo "Đã lưu cọc và giữ phòng …" (hoặc "… nhớ gắn khách trước khi ký" nếu bạn chỉ nhập tên gợi nhớ); lỗi thì không có bản ghi nào được tạo. Hạn giữ chỗ **chỉ để nhắc**: quá hạn, phòng vẫn giữ cho khách này đến khi bạn huỷ giữ chỗ hoặc ký hợp đồng.

::: danger Tạo phiếu cọc chưa phải là đã thu tiền
Phiếu cọc đi theo luồng duyệt/nhận tiền hiện hành; phiếu **chờ duyệt** chưa tính là đã nhận. Chỉ phiếu đã ghi sổ (**POSTED**) trên một sổ quỹ thật mới chứng minh tiền đã vào quỹ. Sau khi tạo, mở [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) hoặc [Thu chi](/03-quan-ly-van-hanh/thu-chi/) để kiểm trạng thái phiếu. Khoản cọc được ghi riêng và **không tính vào KQKD**.
:::

::: warning Khách gợi nhớ phải được gắn khách thật trước khi ký hợp đồng
Tên gợi nhớ được ghi làm **người nộp** và vào ghi chú phiếu thu cọc ("Khách gợi nhớ lúc nhận cọc: …"). Trước khi ký hợp đồng, vào [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/), mở hồ sơ giữ chỗ và ấn **Gắn khách** để chọn khách trong danh bạ; màn ký hợp đồng từ chối ký nếu chưa gắn.
:::

::: warning Trang công khai chỉ tạo, không huỷ
Trang công khai không có nút gỡ giữ chỗ. Khi khách đổi ý, vào [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/), khối **Giữ chỗ / Cọc trước hợp đồng**, dùng **Hủy giữ chỗ** (giữ chỗ 0 đồng tạo từ trước) hoặc **Xử lý cọc hiện tại** (đã nhận cọc) trước khi mở bán lại phòng.
:::

## Lock tạm phòng (ẩn phòng 6, 12 hoặc 24 giờ)

Lock tạm dùng khi cần giữ một phòng trong thời gian ngắn mà **chưa có khách, chưa thu tiền, chưa tạo phiếu**. Nút chỉ có trong app khi bạn đã đăng nhập và có quyền `sale_phong.lock_room`: danh sách phòng trống trong **Sale Phòng** trên điện thoại (`/sale-phong`), hoặc link `/r/...` khi bạn đang đăng nhập.

1. Mở thẻ của phòng đang **Trống** hoặc **Sắp trống**, ấn **Lock tạm**.
2. Chọn **6 giờ**, **12 giờ** hoặc **24 giờ** (mặc định 24), nhập **Ghi chú** nếu cần (tuỳ chọn), rồi ấn nút **Lock** của hộp thoại.

Sau khi lock:

- Phòng **biến khỏi link công khai**, khỏi ảnh **Danh sách phòng trống** và khỏi tin Zalo phòng trống ngay lập tức.
- Trong app, nhân viên vẫn thấy phòng với nhãn **Đã chốt tạm · còn X giờ · bởi …**.
- Hết giờ mà chưa ai tạo phiếu cọc thì phòng **tự hiện lại**, không cần ai bấm. Với worker gửi tin Zalo phòng trống, phòng hiện lại được coi như phòng mới.
- **Gỡ lock sớm**: người đã lock (còn quyền) hoặc người có quyền tạo cọc ở toà đó; có bước xác nhận.
- Khi quản lý tạo phiếu cọc cho phòng đang lock (nút **Tạo phiếu cọc** trên thẻ phòng đang chốt tạm, hoặc khối **Phòng đang lock chờ tạo phiếu** ở [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/)), lock **tự gỡ trong cùng lần lưu**.

## Đo đếm lượt xem của khách

Mọi thao tác của khách trên trang — mở trang, thời gian xem, phòng nào được hiện ra / mở chi tiết, bấm Gọi / Zalo / Chia sẻ / Tải ảnh — đều được **ghi nhận ẩn danh**, cùng lỗi phát sinh trên trình duyệt của khách. Bạn xem ở **Sale Phòng => tab Thống kê**: Tổng quan, Phòng được xem nhiều, Theo thời gian, Theo link và **Lỗi**. Có công tắc **Loại trừ lượt xem nội bộ** để không tính những lần chính nhân viên mở trang.

## Các tính năng khác

| Nút / khu vực | Công dụng |
| --- | --- |
| Chip **Quận** / **Tòa nhà** / **Khoảng giá** | Lọc nhanh phòng theo quận, toà hoặc dải giá. |
| Chip **Tổng hợp** | Xem gộp tất cả các toà trong một màn, mỗi toà một thẻ tóm tắt. |
| Chuyển **Danh sách / Sơ đồ** | Đổi giữa xem thẻ phòng và xem mặt bằng từng tầng. |
| **Tải ảnh** (đầu trang) | Xuất một ảnh bảng danh sách phòng trống để gửi nhanh. |
| **Gọi Quản Lý / Gọi khách**, **Zalo** | Liên hệ theo số của toà (nếu có) hoặc hotline chung; với phòng khách nhờ sale là số khách hoặc quản lý. |
| **Chỉ đường** | Mở bản đồ tới toà (link riêng của toà nếu có, không thì tìm theo địa chỉ). |
| **Chia sẻ** / **Tải ảnh** (chi tiết phòng) | Gửi thông tin phòng kèm toàn bộ ảnh qua trình chia sẻ của điện thoại, hoặc lưu ảnh về máy. |
| **Tạo cọc giữ phòng** | Chỉ hiện khi bạn đăng nhập + có quyền `create_deposit` — mở hộp **Nhận cọc giữ phòng**. |
| **Lock tạm** | Chỉ hiện khi bạn đăng nhập + có quyền `lock_room`, trên phòng Trống / Sắp trống — ẩn phòng khỏi danh sách sale 6 / 12 / 24 giờ. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Khách mở link báo **"Liên kết không hợp lệ hoặc đã hết hạn"** | Liên kết đã bị **thu hồi**, bị xoá hoặc gõ sai token. Vào **Sale Phòng => Link chia sẻ** để **Khôi phục** link đã thu hồi hoặc tạo link mới rồi gửi lại. |
| Trang báo **"Chưa tải được danh sách phòng"** | Lỗi mạng tạm thời. Bấm **Thử lại**; trang cũng tự thử lại. |
| **Không thấy toà nào** trên trang | Trang chỉ hiện toà có ít nhất một phòng **trống / sắp trống / khách nhờ sale**. Toà đã kín phòng sẽ không xuất hiện — đúng thiết kế. |
| **Không thấy nút "Tạo cọc giữ phòng"** dù đang đăng nhập | Bạn thiếu quyền **Sale Phòng => Tạo cọc nhanh** (`create_deposit`), đang mở ở tab chưa đăng nhập, hoặc phòng đã thuê / là phòng khách pass. Xem [Phân quyền](/05-cai-dat/phan-quyen/). |
| Hộp **Nhận cọc giữ phòng** báo "Gõ tên khách gợi nhớ hoặc chọn khách trong danh bạ." | Chọn khách bằng **Danh bạ** hoặc gõ tên gợi nhớ (tối đa 120 ký tự). |
| Hộp **Nhận cọc giữ phòng** không cho lưu vì số tiền | Số tiền cọc phải lớn hơn 0 và phải chọn **Sổ quỹ nhận cọc**. Muốn giữ phòng không thu tiền thì dùng **Lock tạm**. |
| Không thấy nút **Lock tạm** | Bạn thiếu quyền **Lock tạm phòng** (`sale_phong.lock_room`; mặc định chỉ vai Chủ sở hữu tổ chức có, chủ gán thêm trong [Phân quyền](/05-cai-dat/phan-quyen/)), hoặc phòng không ở trạng thái Trống / Sắp trống. |
| Phòng vừa giữ chỗ **vẫn còn** trên link của khách | Bảo khách tải lại trang; trạng thái đổi ở lần làm mới kế tiếp. |
| Số liên hệ hiển thị **sai** | Đặt **Liên hệ quản lý toà** trong **Sale Phòng => Thông tin sale**, hoặc chỉnh hotline chung ở [Hotline](/05-cai-dat/hotline/). |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/sale-phong" app-label="Mở trang Sale Phòng" fixtures="Snapshot 07/10/2026: DEMO chưa có link chia sẻ nào." view-only>

Trang công khai cần một token chia sẻ, mà DEMO hiện chưa có link nào, nên bài thử chỉ xem:

1. Vào **Sale Phòng => tab Link chia sẻ**, quan sát dòng "Chưa có link chia sẻ nào" và nút **Tạo link mới** — không tạo link trên tài khoản dùng chung.
2. Sang tab **Cài đặt hiển thị** để xem **Số ngày báo "sắp trống"** và **Hotline hiển thị** — hai thiết lập quyết định nhãn **Sắp trống** và số liên hệ khách thấy.
3. Sang tab **Thống kê** để xem các chỉ số sẽ được ghi khi khách mở link.

Kết quả mong đợi: bạn biết nơi tạo link, nơi chỉnh cách trang công khai hiển thị và nơi xem lượt truy cập, không có dữ liệu DEMO nào bị tạo.

</SandboxTry>

## Quy trình liên quan

- [Sale Phòng](/03-quan-ly-van-hanh/sale-phong/) — nơi tạo liên kết chia sẻ, cấu hình hiển thị, ảnh sale, sơ đồ tầng và xem thống kê lượt truy cập.
- [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) — theo dõi, bổ sung, huỷ giữ chỗ và xử lý cọc sau khi tạo trên trang công khai.
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/) — kiểm phiếu cọc đã duyệt và đã ghi sổ hay chưa.
- [Hotline](/05-cai-dat/hotline/) — cấu hình số hotline mặc định hiển thị trên trang công khai.
- [Phân quyền](/05-cai-dat/phan-quyen/) — cấp quyền `sale_phong.view`, `manage_tokens`, `create_deposit` cho nhân viên.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — quản lý phòng, giá và theo dõi dọn/sửa làm nguồn cho trang công khai.
