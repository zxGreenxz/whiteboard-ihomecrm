---
title: "Thu chi — tạo phiếu, duyệt & in"
description: "Ghi mọi khoản tiền vào/ra bằng phiếu thu/chi gắn vào sổ quỹ: tạo phiếu theo hạng mục, lọc và duyệt/huỷ, in phiếu A5 và xuất/nhập dữ liệu."
routes: ["/income-expense"]
permissions: [{module: income_expenses, action: view}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Thu chi — tạo phiếu, duyệt & in

Màn **Thu chi** là nơi mọi đồng tiền vào/ra hệ thống được ghi nhận: thu tiền phòng, thu phí phạt, chi sửa chữa, chi lương, hoàn cọc… Mỗi khoản là một **phiếu thu** hoặc **phiếu chi** gắn vào một **sổ quỹ** cụ thể. Số dư của mọi sổ quỹ và mọi báo cáo lợi nhuận/dòng tiền đều đọc từ chính các phiếu ở đây, nên khi bạn lưu một phiếu là bạn đang thay đổi số tiền thật trong sổ. Trang này hướng dẫn bạn tạo phiếu, lọc và tìm phiếu, duyệt/huỷ, in phiếu A5 và nhập/xuất dữ liệu.

::: info Điều kiện tiên quyết
- Quyền **Thu chi => Xem** (module `income_expenses`, action `view`) để mở màn; quyền **Tạo / Sửa / Xoá** tương ứng để lập, sửa và huỷ phiếu.
- Đã có ít nhất một **sổ quỹ** để tiền chảy vào/ra và một bộ **loại (hạng mục) thu chi** — xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/).
- Là nhân viên, bạn chỉ thấy và ghi phiếu ở các **toà được gán phạm vi**. Kế toán được cấp quyền **Mọi toà nhà** (`income_expenses.all_buildings`) mới ghi được thu chi cho mọi toà của chủ (xem phần bên dưới).
- Hạng mục **hạn chế** (ví dụ "Quản Lý") chỉ hiện với người có quyền `restricted_create` / `restricted_view`.
:::

## Hướng dẫn từng bước

**Bước 1**: Vào menu **Tài chính => Thu chi**. Màn mở ra danh sách phiếu cùng **3 thẻ thống kê** (Tổng thu / Tổng chi / Chênh lệch) và công tắc chuyển giữa **Phiếu lẻ** và **Phiếu tổng**. Trong dữ liệu demo bạn thấy sẵn 2 phiếu: một **phiếu chi sửa chữa 500.000đ** và một **phiếu thu phí phạt 200.000đ**.

![Màn Thu chi liệt kê phiếu: chi sửa chữa 500.000đ và thu phí phạt 200.000đ, kèm 3 thẻ thống kê ở đầu trang](./images/buoc-01-danh-sach.webp)

**Bước 2**: Đọc danh sách và 3 thẻ. Mỗi dòng cho biết Mã phiếu (thu = `PT…`, chi = `PC…`), Nội dung, Toà/Phòng, Người gửi/nhận, Sổ quỹ, Số tiền, Ngày phát sinh và Trạng thái duyệt. **Số tiền của phiếu luôn bằng tổng các hạng mục** — bạn không gõ tổng bằng tay.

::: tip 3 thẻ thống kê có thể lệch số dư sổ quỹ
Mặc định danh sách hiển thị cả phiếu **Đã duyệt** lẫn phiếu **Nháp** (chưa duyệt), nên tổng thu/chi ở 3 thẻ có thể **cao hơn** số dư thực của sổ quỹ. Số dư sổ quỹ chỉ cộng các phiếu **Đã duyệt**. Đây là bình thường, không phải sai sót.
:::

**Bước 3**: Lọc để tìm đúng phiếu. Thanh lọc cho phép lọc theo **Toà nhà** (chọn 1 toà hoặc Tất cả), **Phòng**, **Sổ quỹ**, **Loại phiếu** (Thu/Chi), **Khoảng ngày**, **Trạng thái duyệt**, **Loại (hạng mục)** và **Nhóm hạng mục**, **Người tạo**, **Đã kiểm** và **Kỳ áp dụng theo tháng**. Ô tìm kiếm thông minh: gõ **toàn số** để tìm theo số tiền, gõ **chữ** để tìm theo tên/mã phiếu/tên khách. Bộ lọc và ô tìm được **giữ lại khi bạn tải lại trang (F5)**.

**Bước 4**: Tạo một phiếu mới — ấn **Tạo phiếu thu** hoặc **Tạo phiếu chi**. Tại form, điền lần lượt:
- **Loại phiếu**: Thu hay Chi (đã chọn sẵn theo nút bạn bấm).
- **Sổ quỹ** (bắt buộc): tiền sẽ chảy vào (phiếu thu) hoặc ra (phiếu chi) từ sổ này.
- **Toà nhà** (bắt buộc) và tuỳ chọn **Phòng** — mọi phiếu đều phải gắn một toà; khoản chung không thuộc toà thật thì chọn toà ảo **Chung**.
- **Người gửi** (với phiếu thu) hoặc **Tên người nhận** (với phiếu chi), **Ngày phát sinh**, **Ghi chú**.
- **Hạng mục**: thêm một hay nhiều dòng, mỗi dòng gồm **Hạng mục**, **Số lượng** và **Đơn giá**. Số tiền mỗi dòng = số lượng × đơn giá; **tổng phiếu = tổng các dòng** (tự tính).

Ấn **Lưu** để ghi phiếu.

::: danger Lưu phiếu là thao tác ghi tiền vào sổ quỹ
Phiếu tạo qua form mặc định là **Đã duyệt ngay** — nghĩa là nó **lập tức cộng/trừ vào số dư sổ quỹ** và đi vào báo cáo. Hãy kiểm tra kỹ **loại phiếu, sổ quỹ, hạng mục và số tiền** trước khi bấm Lưu. Đây là tiền thật.
:::

**Bước 5**: Chọn hoặc tạo hạng mục. Ô **Hạng mục** là combobox gõ-để-tìm; nếu chưa có, bạn gõ tên rồi **tạo mới** ngay trong form — khi tạo mới **bắt buộc chọn Nhóm** (category) để báo cáo gom nhóm đúng. Lưu ý về hạch toán:
- Hạng mục **cọc** ("Tiền cọc", "Cọc giữ phòng"…) được đánh dấu là cọc: phần tiền của dòng cọc **không tính vào Kết quả kinh doanh (KQKD)** dù vẫn nằm trong sổ quỹ. Vì vậy một phiếu thu tháng đầu có thể **trộn** vừa tiền phòng vừa tiền cọc trên **cùng một phiếu** — báo cáo tự loại phần cọc.
- Hạng mục **hạn chế** chỉ hiện với người có quyền; người khác không thấy hạng mục lẫn phiếu chứa nó.

::: warning Sửa phiếu khó hoàn tác — dùng đúng cách sửa
Với phiếu **đã duyệt**, người tạo thường chỉ được **Sửa nhanh** (đổi sổ quỹ, ghi chú, tệp đính kèm); còn sửa số tiền/hạng mục cần quyền quản trị và sẽ **tính lại toàn bộ số dư**. Nếu ghi sai số tiền hẳn, cách an toàn là **Huỷ** phiếu sai rồi lập phiếu mới, thay vì chỉnh tay từng dòng.
:::

**Bước 6**: Duyệt hoặc huỷ phiếu. Mở phiếu để xem chi tiết:
- **Duyệt** một phiếu còn ở trạng thái Nháp (ví dụ phiếu chi hoa hồng chờ thực chi) để nó được tính vào tồn quỹ.
- **Huỷ** một phiếu sai — phiếu chuyển sang **Đã huỷ**, không còn tính vào số dư; nếu là phiếu thu sinh ra từ thanh toán hoá đơn, hệ thống gỡ luôn khoản thu tương ứng khỏi hoá đơn. Mọi lần huỷ/khôi phục đều được ghi **Nhật ký thao tác**; khôi phục phiếu đã huỷ chỉ Super Admin làm được.

::: danger Duyệt phiếu = đưa phiếu vào tồn quỹ
Khi bạn **Duyệt**, phiếu lập tức cộng/trừ vào số dư sổ quỹ và vào báo cáo. Ngược lại, **Huỷ** một phiếu thu đã ghi nhận sẽ **rút khoản tiền đó khỏi sổ quỹ** (và khỏi hoá đơn nếu là phiếu thu hoá đơn). Chỉ thao tác khi chắc chắn.
:::

**Bước 7**: In phiếu. Từ một phiếu, chọn **In** để mở trang in **A5** (`/income-expense/print/:id`) — trang tự gọi hộp in sau khoảng nửa giây, hiển thị mã phiếu, người gửi/nhận, tài khoản nhận, các hạng mục và tổng tiền. Bạn có thể cấu hình **mẫu thu chi** riêng cho phiếu thu và phiếu chi ở phần **Cài đặt => Mẫu thu chi**.

## Các tính năng khác trên màn hình

| Nút / Bộ lọc | Công dụng |
| --- | --- |
| Công tắc **Phiếu lẻ / Phiếu tổng** | Xem từng phiếu riêng, hoặc gộp nhiều phiếu con của cùng một đợt thu/chi nhiều toà thành **phiếu tổng**. |
| **Tạo phiếu thu** / **Tạo phiếu chi** | Mở form lập phiếu; số tiền tự tính từ tổng các hạng mục. |
| **Tạo nhanh** (nút nổi trên mobile) | Nhập 1 dòng `(phòng) (toà) (hạng mục) (ghi chú) (số tiền)`; số tiền luôn ×1000 (`200` = 200.000đ); sổ quỹ tự chọn theo toà. |
| Ô tìm kiếm | Gõ số → tìm theo số tiền; gõ chữ → tìm theo tên/mã phiếu/tên khách (tìm phía máy chủ, có phân trang). |
| Bộ lọc **Sổ quỹ** | Lọc phiếu theo sổ (bao gồm cả sổ ghi tiền thối). Xem log tiền thối/làm tròn ở màn [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/). |
| Bộ lọc **Loại (hạng mục)** / **Nhóm hạng mục** | Lọc theo từng hạng mục hoặc theo nhóm (Lương, Chia lợi nhuận…); chọn cả hai thì lấy phiếu khớp **cả hai**. |
| **Đánh dấu đã kiểm** | Đánh dấu phiếu đã đối chiếu (độc lập với duyệt) — chỉ có trên bản desktop. |
| **Sinh phiếu lặp lại** | Sinh các phiếu con định kỳ (tuần/tháng/quý/năm) từ phiếu gốc có chu kỳ lặp. |
| **Import** (Excel) | Nhập hàng loạt — mỗi dòng Excel = 1 phiếu 1 hạng mục; nhập tuần tự từng dòng, dòng lỗi không làm hỏng dòng đã vào. |
| **Ghi cho mọi toà** (kế toán) | Với quyền `income_expenses.all_buildings`, dropdown Toà/Phòng trong form mở rộng ra mọi toà của chủ; danh sách và ô lọc vẫn theo phạm vi thường (tên toà ngoài phạm vi hiện "—"). |
| **In** | Mở trang in phiếu A5. |
| **Khôi phục phiếu (Super Admin)** | Đưa một phiếu **Đã huỷ** trở lại Đã duyệt; tái tạo khoản thu hoá đơn nếu có. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Tổng 3 thẻ thống kê **không khớp** số dư sổ quỹ | Bình thường: 3 thẻ gồm cả phiếu **Nháp**, còn số dư chỉ tính phiếu **Đã duyệt**. Lọc trạng thái **Đã duyệt** để đối chiếu. |
| Không gõ được **tổng tiền** của phiếu | Đúng thiết kế: tổng = tổng các **hạng mục**. Sửa số lượng/đơn giá từng dòng để đổi tổng. |
| Lưu phiếu xong tổng = **0đ** | Hạng mục không thêm được (ví dụ chọn nhầm hạng mục của người khác bị chặn). Mở lại phiếu, xoá và thêm lại hạng mục hợp lệ. |
| Thu cọc bị tính thành **doanh thu** trong báo cáo lợi nhuận | Kiểm tra dòng cọc dùng đúng **hạng mục cọc** ("Tiền cọc"…). Chỉ hạng mục cọc mới được loại khỏi KQKD; cọc gộp chung phiếu tháng đầu vẫn được loại tự động theo từng hạng mục. |
| Khách trả **thiếu vài nghìn** nhưng hoá đơn vẫn **Đã thu** | Thiếu **dưới 10.000đ** được "làm tròn tha" — hoá đơn tính là đủ, phần thiếu ghi vào sổ "Làm tròn tiền thiếu" (log, không phải tiền thật). |
| **Tiền thối** không thấy trừ khỏi sổ | Đúng: tiền thối **đã net** trong tổng thu của phiếu; sổ "Thối" chỉ là ledger ghi nhận, không trừ thêm lần nữa. |
| Ghi phương thức là **Tiền mặt / Chuyển khoản** | Giữ nguyên mã **TM / TT / TK** (và **CT** = cấn trừ do hệ thống tự sinh) — không dịch, không đổi. |
| Không lập/sửa được phiếu, báo lỗi khoá sổ | Sổ quỹ đó đã **khoá sổ** đến một ngày; phiếu có ngày ≤ ngày khoá bị chặn. Đổi ngày phiếu hoặc nhờ chủ sổ mở khoá. |
| Kế toán **không thấy toà** cần ghi trong ô lọc | Ô lọc/danh sách theo phạm vi thường; quyền **Mọi toà nhà** chỉ mở rộng **dropdown trong form** — cứ mở form Tạo phiếu để chọn toà. |
| Không thấy nút **Đánh dấu đã kiểm** trên điện thoại | Tính năng "đã kiểm" chỉ có ở **desktop**. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/income-expense" app-label="Mở màn Thu chi" fixtures="1 phiếu chi sửa chữa 500.000đ, 1 phiếu thu phí phạt 200.000đ, 3 sổ quỹ demo">

Thực hành lập và duyệt một phiếu chi để thấy tiền chảy vào sổ quỹ:

1. Xem danh sách: đã có sẵn **phiếu chi sửa chữa 500.000đ** và **phiếu thu phí phạt 200.000đ**.
2. Ấn **Tạo phiếu chi**. Chọn một **sổ quỹ** trong 3 sổ demo, chọn **Toà DEMO A**, người nhận **Nguyễn Văn A**, ngày hôm nay.
3. Thêm một hạng mục: chọn **DEMO Chi Đặc Biệt**, số lượng **1**, đơn giá **300.000** — tổng phiếu tự thành **300.000đ**. Ấn **Lưu**.
4. Mở phiếu vừa tạo và ấn **Duyệt** (nếu phiếu chưa ở trạng thái Đã duyệt) để nó được tính vào tồn quỹ. Để ý số dư của sổ bạn vừa chọn **giảm 300.000đ**.
5. Xong bấm **Reset** để trả sandbox về trạng thái ban đầu.

Kết quả mong đợi: bạn hiểu rằng lập/duyệt một phiếu thu hoặc chi là ghi trực tiếp vào **sổ quỹ** — tổng phiếu bằng tổng các hạng mục, và chỉ phiếu **Đã duyệt** mới đổi số dư sổ.

</SandboxTry>

## Quy trình liên quan

- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — tạo sổ quỹ và bộ hạng mục thu chi mà phiếu sẽ dùng.
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) — xem tồn quỹ từng sổ, khoá/mở khoá sổ, chia sẻ sổ.
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — thu tiền phòng theo hoá đơn; mỗi lần thu tự sinh một phiếu thu ở đây.
- [Thu tiền mặt (mobile)](/03-quan-ly-van-hanh/thu-tien-mobile/) — đi thu tiền từng phòng, thu đủ/thu một phần trên điện thoại.
- [Bàn giao & đối soát sổ](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — bàn giao tiền đã thu về cho chủ và chốt số sổ.
- [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) — xem log tiền thối và làm tròn tiền thiếu.
- [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) — nhận cọc; phiếu cọc là một phiếu thu ở màn này.
