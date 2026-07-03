---
title: "Báo cáo: Danh sách tiền cọc"
description: "Xem các khoản tiền cọc theo từng phòng/khách và phân loại (đang giữ chỗ, đã chuyển hợp đồng, đã hoàn, mất cọc), lọc theo tòa nhà."
routes: ["/report/finance/deposit"]
permissions: [{module: reports_finance, action: view}]
viewport: desktop
audience: [chu-nha, ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Báo cáo: Danh sách tiền cọc

Báo cáo **Danh sách tiền cọc** cho bạn — chủ nhà, kế toán hoặc quản lý tòa — một bảng liệt kê các **khoản tiền cọc** theo **từng phòng và từng khách**, kèm **phân loại** trạng thái của mỗi khoản: đang **giữ chỗ**, đã **chuyển vào hợp đồng**, đã **hoàn** cho khách hay khách đã **mất cọc**. Bên trên có dòng **Tổng** cộng nhanh số tiền cọc của các dòng đang hiển thị. Đây là màn **chỉ để xem** — bạn không ghi/sửa cọc tại đây.

Điều quan trọng nhất cần nhớ ngay từ đầu: đây là **bản kê nhìn nhanh theo trạng thái phiếu cọc**, còn nơi **theo dõi chính xác cọc đang giữ và cọc còn thiếu của từng hợp đồng** là trang [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/). Lý do: số cọc thực khách đã đưa hiện được tính từ **phiếu thu có hạng mục "Tiền cọc"** (chứ không phải từ trạng thái ở bản kê này) — xem mục [Nguồn số liệu](#nguồn-số-liệu) bên dưới. Vì vậy, nếu một khoản cọc giữ chỗ được ghi bằng phiếu thu (cách chuẩn hiện nay), nó có thể **không xuất hiện** trong danh sách này; hãy đối chiếu với trang Đặt cọc.

::: info Điều kiện tiên quyết
- Quyền **Báo cáo tài chính => Xem** (module `reports_finance`, action `view`) để mở màn báo cáo; route này gate theo feature key `reports_finance.deposits_report`.
- Đã có ít nhất vài **phiếu đặt cọc / cọc giữ chỗ** được ghi nhận thì bảng mới có dòng để đọc (xem [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/)).
- Nếu bạn là nhân viên, chỉ thấy cọc của các **tòa nhà bạn được phân quyền** (theo phạm vi RLS); chủ nhà thấy toàn bộ.
:::

## Cách mở

**Bước 1**: Vào menu **Báo cáo** => nhóm **Tài chính** => **Danh sách tiền cọc**. Màn mở ra với hai ô lọc ở đầu trang (**Loại cọc** và **Tòa nhà**), dòng **Tổng** ngay dưới đó, rồi tới **bảng danh sách cọc** 7 cột và thanh phân trang ở chân trang.

![Màn hình báo cáo](./images/buoc-01-man-hinh.webp)

## Bộ lọc & cách đọc số

| Cột / Chỉ số | Ý nghĩa |
| --- | --- |
| Ô lọc **Loại cọc** | Lọc theo **Phân loại** của khoản cọc. Gõ-để-tìm, gồm **Tất cả loại cọc** (mặc định) và 5 trạng thái: **Chờ xác nhận**, **Đã xác nhận**, **Đã chuyển HĐ**, **Đã hoàn**, **Mất cọc**. |
| Ô lọc **Tòa nhà** | Chọn **một** tòa để xem riêng, hoặc để **Tất cả toà nhà** để gộp chung. Dropdown có gõ-để-tìm; lọc theo tòa của **phòng** gắn với khoản cọc. |
| Dòng **Tổng** | Cộng cột **Số tiền cọc** của **các dòng đang hiển thị** (đã áp bộ lọc Loại cọc + Tòa nhà). Đổi bộ lọc thì Tổng tính lại. |
| Cột **Tòa nhà** | Tên tòa của phòng gắn khoản cọc (trống thì hiện "—"). |
| Cột **Căn hộ** | Số phòng được đặt cọc / giữ chỗ. |
| Cột **Khách hàng** | Tên khách đặt cọc (ưu tiên tên từ lead, sau đó tên khách thuê). |
| Cột **Số tiền cọc** | Số tiền của khoản cọc đó (đây là cột được cộng vào dòng **Tổng**). |
| Cột **Số tiền cọc (giữ chỗ)** | Chỉ hiện số khi Phân loại là **Chờ xác nhận** hoặc **Đã xác nhận** — tức tiền cọc **đang giữ chỗ** cho khách, chưa chuyển thành hợp đồng; các trạng thái khác để "—". |
| Cột **Số tiền cọc (trong hóa đơn)** | Chỉ hiện số khi Phân loại là **Đã chuyển HĐ** — tức khoản cọc **đã chuyển vào hợp đồng** (gộp thu qua hóa đơn tháng đầu); các trạng thái khác để "—". |
| Cột **Phân loại** | Trạng thái của khoản cọc, xem bảng nghĩa bên dưới. |
| **Số bản ghi** (chân trang) | Chọn hiển thị **10 / 20 / 50 / 100** dòng mỗi trang; dòng chữ bên phải cho biết đang xem "X - Y trên tổng số Z bản ghi". |

**Ý nghĩa của cột Phân loại:**

| Phân loại | Nghĩa nghiệp vụ |
| --- | --- |
| **Chờ xác nhận** | Phiếu cọc mới ghi, chưa xác nhận. Vẫn tính là tiền **đang giữ chỗ**. |
| **Đã xác nhận** | Cọc đã xác nhận, khách **đang giữ chỗ** một phòng nhưng chưa ký hợp đồng. |
| **Đã chuyển HĐ** | Cọc đã **chuyển thành hợp đồng** — khoản cọc đi vào phần thu của hợp đồng (hóa đơn tháng đầu). |
| **Đã hoàn** | Đã **hoàn cọc** lại cho khách (thường khi khách trả phòng, thanh lý bình thường). |
| **Mất cọc** | Khách **bỏ cọc** — cọc được giữ lại và hạch toán thành doanh thu thanh lý. |

::: warning Bản kê theo trạng thái phiếu — không phải sổ theo dõi cọc chính thức
Báo cáo này gom cọc theo **trạng thái phiếu đặt cọc** ở cột **Phân loại**. Trong khi đó, hệ thống hiện lấy **số cọc thực khách đã nộp** từ **phiếu thu có hạng mục "Tiền cọc"** (phản ánh vào **cọc đã thu / còn thiếu** của từng hợp đồng), và việc **hoàn/mất cọc** được ghi khi **thanh lý hợp đồng**. Do đó:

- Con số ở đây **có thể lệch** với trang [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) và với thẻ cọc trên [Bảng tin/Trang chủ](/02-theo-doi-nhanh/bang-tin/).
- Một khoản **cọc giữ chỗ ghi bằng phiếu thu** (cách chuẩn hiện nay) có thể **không hiện** trong bảng này, và bảng cũng **không có cột "cọc còn thiếu"**.
- Muốn biết **hợp đồng nào đủ/thiếu cọc** và **cọc đang giữ thực tế**, hãy dùng trang [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) (các tab Đủ/Thiếu cọc, Phiếu giữ chỗ) thay cho báo cáo này.
:::

## Nguồn số liệu

Báo cáo đọc từ **sổ đặt cọc** (các bản ghi phiếu cọc) — mỗi dòng là một khoản cọc, kèm phòng và khách gắn với nó. Cụ thể:

- **Phân loại** lấy từ trạng thái của phiếu cọc; hai cột phụ **(giữ chỗ)** và **(trong hóa đơn)** chỉ là cách tách cùng một số tiền theo trạng thái: **Chờ xác nhận / Đã xác nhận** rơi vào "giữ chỗ", **Đã chuyển HĐ** rơi vào "trong hóa đơn".
- **Lọc tòa nhà** chạy **ngay trên máy bạn** (client-side) theo tòa của phòng gắn khoản cọc; **Loại cọc** lọc theo trạng thái. **Tổng** là tổng cột Số tiền cọc sau khi lọc.
- **Nguồn sự thật của cọc đã thu KHÔNG nằm ở báo cáo này.** Số cọc thực khách đưa được hệ thống tính từ **phiếu thu có hạng mục "Tiền cọc"** (loại thu `is_deposit`) đã duyệt và gắn hợp đồng, rồi phản ánh vào **cọc đã thu / còn thiếu** của hợp đồng; việc **hoàn/mất cọc** đọc từ **bản ghi thanh lý hợp đồng**. Vì báo cáo này phân loại theo **trạng thái phiếu cọc** (một trường riêng, kiểu cũ), số liệu có thể **không khớp** với trang [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/).

Hệ quả thực dụng: nếu bảng **trống hoặc thiếu** những khoản cọc bạn biết là đã thu, đó thường là vì các khoản đó được ghi bằng **phiếu thu tiền cọc** (không đi qua sổ đặt cọc kiểu cũ). Khi đó hãy mở trang **Đặt cọc** để xem đúng số.

## Xuất & mẹo

- **Không có nút xuất Excel/PDF riêng** trên màn này. Cần lưu lại, bạn dùng chức năng **In** của trình duyệt (Ctrl/Cmd + P → lưu PDF), hoặc chụp màn hình bảng.
- **Lọc trước cho gọn**: đặt **Loại cọc = Đã xác nhận** (hoặc **Chờ xác nhận**) để chỉ còn các khoản **đang giữ chỗ**; đặt **Đã chuyển HĐ** để xem cọc đã vào hợp đồng.
- **Bộ lọc giữ nguyên qua F5**: ô **Loại cọc**, ô **Tòa nhà** và cỡ trang được nhớ lại, bạn không phải chọn lại sau khi tải lại trang.
- **Đối chiếu đúng chỗ**: cần con số cọc **đủ/thiếu theo hợp đồng** thì dùng [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/); cần biết cọc đã **hoàn** hay **mất** khi khách trả phòng thì xem [Thanh lý – khách trả phòng](/03-quan-ly-van-hanh/thanh-ly-move-out/) và [Thanh lý – bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/).
- **Phòng đang giữ chỗ vì có cọc** sẽ tự tách khỏi nhóm "Còn trống" trên Sơ đồ tòa nhà và Danh mục căn hộ — đó là cách hệ thống khóa phòng `RESERVED` khi có cọc, độc lập với bản kê này.

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/report/finance/deposit" app-label="Mở báo cáo Danh sách tiền cọc" fixtures="Tòa DEMO A/B, 8 phòng đang thuê, cọc giữ chỗ A301/A302, khách Nguyễn Văn A, cọc mẫu 1.000.000đ" view-only>

Bài này **chỉ xem** — bạn quan sát danh sách cọc, không ghi/sửa cọc:

1. Nhìn dải breadcrumb **Báo cáo tài chính › Danh sách tiền cọc** và dòng **Tổng** ngay dưới bộ lọc. Hãy nhìn thấy **bảng 7 cột**: **Tòa nhà · Căn hộ · Khách hàng · Số tiền cọc · Số tiền cọc (giữ chỗ) · Số tiền cọc (trong hóa đơn) · Phân loại**.
2. Mở ô **Loại cọc** — hãy nhìn thấy đủ **5 mức**: **Chờ xác nhận**, **Đã xác nhận**, **Đã chuyển HĐ**, **Đã hoàn**, **Mất cọc** (cạnh mục **Tất cả loại cọc**).
3. Đổi ô **Tòa nhà** qua lại giữa **DEMO A** và **DEMO B** rồi để **Tất cả toà nhà** — bảng và dòng **Tổng** lọc theo từng tòa. Ở dòng có Phân loại **Đã xác nhận**, cột **(giữ chỗ)** có số còn cột **(trong hóa đơn)** để "—"; ở dòng **Đã chuyển HĐ** thì ngược lại.
4. Nếu bảng **trống** hoặc **không thấy** cọc giữ chỗ **A301/A302** (hay khoản **1.000.000đ** của khách **Nguyễn Văn A**): đó là điều **bình thường** — các khoản này được ghi bằng **phiếu thu tiền cọc**, không nằm trong sổ đặt cọc kiểu cũ mà báo cáo này đọc. Mở trang **Đặt cọc** để thấy chúng.

Kết quả mong đợi: bạn đọc được cấu trúc bản kê cọc (7 cột, 5 Phân loại, dòng Tổng, lọc theo tòa) và hiểu rằng **để theo dõi cọc đang giữ / còn thiếu chính xác**, nơi cần dùng là **trang Đặt cọc**, còn báo cáo này chỉ là bản kê nhanh theo trạng thái phiếu.

</SandboxTry>

## Quy trình liên quan

- [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) — nơi ghi và theo dõi cọc đúng nguồn sự thật: cọc giữ chỗ, cọc đủ/thiếu theo hợp đồng.
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — hợp đồng giữ mức cọc cần thu và số cọc còn thiếu của từng khách.
- [Thu tiền hóa đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — cọc còn thiếu được gộp thu qua hóa đơn tháng đầu, tách thành hạng mục "Tiền cọc" khi thu.
- [Thanh lý – khách trả phòng](/03-quan-ly-van-hanh/thanh-ly-move-out/) — nơi phát sinh việc **hoàn cọc** khi khách rời phòng.
- [Thanh lý – bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/) — nơi phát sinh việc **mất cọc** (cọc thành doanh thu thanh lý).
- [Khách nợ tiền](/04-bao-cao/khach-no-tien/) — soi công nợ hóa đơn của khách, bổ trợ cho bức tranh cọc/nợ.
- [Hub Báo cáo Tài chính](/04-bao-cao/hub-tai-chinh/) — điểm vào của toàn bộ báo cáo tài chính.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — mạch từ giữ chỗ, đặt cọc đến ký hợp đồng, để đặt báo cáo này đúng chỗ trong quy trình.
