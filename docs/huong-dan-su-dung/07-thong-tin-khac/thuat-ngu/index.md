---
title: "Thuật ngữ & bảng trạng thái"
description: "Tra cứu nhanh ý nghĩa các trạng thái hợp đồng, phòng, hoá đơn, cọc, hình thức thanh toán và các thuật ngữ KQKD, cọc gộp, gạch nợ, bàn giao, đối soát."
routes: []
permissions: []
viewport: desktop
audience: [chu-nha, quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Thuật ngữ & bảng trạng thái

Trang này là **từ điển tra cứu**: gặp một nhãn trạng thái lạ (ở hợp đồng, phòng, hoá đơn, cọc) hay một cụm từ nghiệp vụ khó hiểu (KQKD, cọc gộp, gạch nợ, bàn giao, đối soát), bạn mở đây tìm nghĩa. Mỗi bảng gom một nhóm trạng thái, kèm **mã hệ thống** (giá trị kỹ thuật đôi khi hiện trên badge hoặc trong dữ liệu xuất ra) và ý nghĩa thực tế. Không cần đọc từ đầu đến cuối — dùng như tra từ điển.

::: tip Đọc bảng thế nào
Cột **Nhãn hiển thị** là chữ bạn thấy trong app; cột **Mã hệ thống** là giá trị gốc (hay gặp khi xuất Excel hoặc xem badge viết tắt như **TM**, **TK**); cột **Ý nghĩa** giải thích khi nào trạng thái đó xuất hiện. Nhãn tiếng Việt có thể chênh nhẹ theo màn hình, nhưng **mã hệ thống thì cố định**.
:::

## Trạng thái hợp đồng

Vòng đời một hợp đồng thuê, hiển thị ở cột trạng thái trang **Hợp đồng** và trong hợp đồng chi tiết.

| Nhãn hiển thị | Mã hệ thống | Ý nghĩa |
|---|---|---|
| **Nháp** | `DRAFT` | Hợp đồng đang soạn, chưa có hiệu lực |
| **Còn hạn** / **Đang ở** | `ACTIVE` | Hợp đồng đang hiệu lực, khách đang thuê |
| *(đã ngưng dùng)* | `EXTENDED` | **Không còn ghi mới.** Trước đây dùng cho hợp đồng đã gia hạn; nay hợp đồng gia hạn **vẫn giữ trạng thái Còn hạn** và được đánh dấu "đã gia hạn" bằng nhãn phụ, không đổi trạng thái |
| **Đã chuyển nhượng** | `TRANSFERRED` | Hợp đồng đã sang tên/chuyển cho người khác |
| **Đã thanh lý** | `TERMINATED` | Hợp đồng đã kết thúc qua thủ tục thanh lý (chốt điện nước, xử lý cọc) |
| **Hết hạn** | `EXPIRED` | Đã qua ngày kết thúc mà không gia hạn |

::: warning "Đã gia hạn" không phải một trạng thái
Một hợp đồng gia hạn **vẫn hiển thị Còn hạn** (`ACTIVE`) — hệ thống suy ra dấu "đã gia hạn" từ lịch sử gia hạn, không đổi sang `EXTENDED`. Vì vậy khi lọc hợp đồng "còn hiệu lực", bạn lọc theo **Còn hạn**, không cần tìm trạng thái riêng cho hợp đồng đã gia hạn.
:::

## Trạng thái phòng

Hiển thị trên **Sơ đồ toà nhà**, trang **Căn hộ / Phòng** và ô lọc phòng.

| Nhãn hiển thị | Mã hệ thống | Ý nghĩa |
|---|---|---|
| **Trống** | `AVAILABLE` | Không có khách, sẵn sàng cho thuê |
| **Đang thuê** | `OCCUPIED` | Có hợp đồng còn hiệu lực |
| **Đã cọc** / **Giữ chỗ** | `RESERVED` | Có phiếu cọc giữ chỗ nhưng chưa lên hợp đồng — phòng bị khoá tạm, ẩn khỏi danh sách phòng trống |
| **Bảo trì** | `MAINTENANCE` | Đang sửa chữa, tạm không cho thuê |
| **Không khai thác** | `UNAVAILABLE` | Ngừng cho thuê (kho, phòng chủ giữ lại…) |

::: tip Trạng thái phòng phần lớn tự chạy
Bạn **không phải chỉnh tay** hai chuyển đổi phổ biến: khi ký/thanh lý hợp đồng, phòng tự đổi **Trống ⇄ Đang thuê**; khi có/hết phiếu cọc giữ chỗ, phòng tự đổi **Trống ⇄ Đã cọc** (kể cả phiếu cọc **chưa duyệt**). Bạn chỉ đặt tay **Bảo trì** hoặc **Không khai thác** khi cần.
:::

## Trạng thái hoá đơn

Hiển thị ở cột trạng thái trang **Hoá đơn** và trong hoá đơn chi tiết.

| Nhãn hiển thị | Mã hệ thống | Ý nghĩa |
|---|---|---|
| **Nháp** | `DRAFT` | Đang soạn, chưa phát hành |
| **Chờ duyệt** | `PENDING_APPROVAL` | Đã lập, chờ duyệt |
| **Đã duyệt** | `APPROVED` | Đã phát hành, chờ thu tiền (phần lớn hoá đơn tạo thẳng vào trạng thái này) |
| **Đã thanh toán** | `PAID` | Đã thu đủ |
| **Thu một phần** | `PARTIAL_PAID` | Khách trả một phần, còn nợ |
| **Quá hạn** | `OVERDUE` | Đã qua hạn thu mà chưa thu đủ |
| **Đã huỷ** | `CANCELLED` | Bị huỷ (có thể khôi phục về Đã duyệt) |

::: tip Đã thanh toán / Thu một phần / Quá hạn được tính tự động
Ba trạng thái **Đã thanh toán**, **Thu một phần**, **Quá hạn** không phải chọn tay — hệ thống tự suy ra từ **số tiền đã thu** so với tổng hoá đơn và **hạn thu**. Bạn chỉ thao tác thu tiền, trạng thái tự cập nhật.
:::

## Hình thức thanh toán (TM · TK · TT · CT)

Badge hình thức trên phiếu thu, phiếu chi và hoá đơn. Hệ thống **giữ nguyên mã viết tắt**, không dịch dài dòng và không gắn icon.

| Mã | Nghĩa | Ghi chú |
|---|---|---|
| **TM** | Tiền mặt | Thu/chi bằng tiền mặt, vào sổ tiền mặt của người thu |
| **TK** | Chuyển khoản (tài khoản) | Tiền vào/ra qua tài khoản ngân hàng |
| **TT** | Thanh toán | Hình thức thanh toán khác được ghi nhận theo mã này |
| **CT** | Cấn trừ | **Gạch nợ, KHÔNG phải tiền mặt** — hệ thống tự sinh, người dùng không chọn tay |

::: warning CT (Cấn trừ) không phải một khoản tiền thật
**CT** là bút toán **gạch nợ** (ví dụ khi thanh lý, cấn phần khách còn nợ vào tiền cọc; hoặc trừ tiền phòng vào lương). Nó **không** làm tăng/giảm tiền mặt trong két, nên trên bảng điều khiển được tách riêng khỏi ô tiền mặt. Bạn **không tạo được** phiếu hình thức CT bằng tay — chỉ hệ thống tự sinh trong các quy trình nói trên.
:::

## Trạng thái cọc

Trạng thái ghi trên phiếu cọc giữ chỗ (trang **Đặt cọc**).

| Nhãn hiển thị | Mã hệ thống | Ý nghĩa |
|---|---|---|
| **Chờ xác nhận** | `PENDING` | Phiếu cọc mới tạo |
| **Đã xác nhận** | `CONFIRMED` | Cọc đã được xác nhận |
| **Đã lên hợp đồng** | `CONVERTED` | Cọc đã chuyển thành hợp đồng thuê |
| **Đã hoàn cọc** | `REFUNDED` | Đã trả lại cọc cho khách |
| **Đã bỏ cọc** | `FORFEITED` | Khách mất cọc (bỏ cọc) |

::: warning Số cọc thật không đọc từ trạng thái này
Trạng thái phiếu cọc ở trên **chỉ mang tính đánh dấu** và không phải nguồn số liệu chuẩn. **Số cọc thực còn giữ** của một hợp đồng được tính từ **các phiếu thu cọc thực tế** (đánh dấu là cọc), trừ đi phần đã hoàn/bỏ. Khi cần biết "còn giữ bao nhiêu cọc", hãy xem số cọc còn lại trên hợp đồng hoặc trang theo dõi cọc, đừng suy từ nhãn phiếu.
:::

## Trạng thái phiếu thu chi

Ghi trên phiếu thu/phiếu chi trong **Sổ quỹ** và **Thu chi**.

| Nhãn hiển thị | Mã hệ thống | Ý nghĩa |
|---|---|---|
| **Đã duyệt** | `APPROVED` | Mặc định khi tạo; **chỉ phiếu Đã duyệt và chưa xoá** mới được tính vào số dư và báo cáo |
| **Chưa duyệt** | `UNAPPROVED` | Không tính vào số dư/báo cáo cho tới khi duyệt |
| **Đã huỷ** | `CANCELLED` | Bỏ, không tính |

## Thuật ngữ nghiệp vụ hay gặp

| Thuật ngữ | Ý nghĩa |
|---|---|
| **KQKD** (Kết quả kinh doanh) | Báo cáo lãi/lỗ (P&L). Doanh thu và chi phí được cộng theo **từng hạng mục** của phiếu thu chi; phần nào là **tiền cọc** sẽ **tự động bị loại** khỏi KQKD, nên một lần thu gộp cả tiền phòng lẫn cọc vẫn hạch toán đúng. Phiếu chia lợi nhuận, lương điều hành, lương quản lý được đánh dấu **không vào KQKD**. |
| **Cọc gộp** | Tiền cọc còn thiếu được gộp thành dòng **Tiền cọc** ngay trong **hoá đơn tháng đầu**. Khi khách trả, hệ thống **tách riêng** phần cọc để nó không bị tính thành doanh thu KQKD, và đưa vào **sổ CỌC (giữ hộ khách)**. |
| **Gạch nợ / Cấn trừ (CT)** | Trừ thẳng vào công nợ thay vì thu/chi tiền mặt. Ví dụ khi thanh lý, phần khách còn nợ được **cấn trừ** vào tiền cọc; bút toán này mang mã **CT**, do hệ thống tự sinh, không phải tiền mặt. |
| **Bàn giao (tiền mặt)** | Nhân viên nộp tiền đã thu lên cho quản lý/kế toán. Một lần bàn giao tạo **1 phiếu chi** (bên giao) và **1 phiếu thu tổng** (bên nhận) kèm các hạng mục chi tiết. |
| **Đối soát / Chốt số sổ** | So khớp số dư **hệ thống tính** với số **thực tế** của sổ/tài khoản tại một mốc ngày, rồi **chốt** để làm mốc cho kỳ sau. Dùng khi bàn giao ca hoặc cuối kỳ. |
| **Sổ quỹ (tài khoản)** | Nơi tiền "nằm": tiền mặt của từng người thu, tài khoản ngân hàng, **sổ CỌC** (giữ hộ khách), sổ hệ thống (làm tròn…). Mọi phiếu thu chi đều gắn **đúng một sổ quỹ**. |
| **Phiếu thu / phiếu chi** | Một lần tiền vào (thu) hoặc ra (chi). Chỉ phiếu **đã duyệt** và chưa xoá mới vào số dư và báo cáo. |
| **Thanh lý hợp đồng** | Kết thúc hợp đồng: chốt điện/nước, tính phần phải thu/phải trả, xử lý tiền cọc (hoàn hoặc bỏ cọc). Sau thanh lý hợp đồng chuyển trạng thái **Đã thanh lý**. |
| **Bỏ cọc (forfeit)** | Khách mất cọc; tiền cọc chuyển thành **doanh thu thanh lý** thay vì hoàn lại khách. |
| **Cọc còn giữ** | Số tiền cọc thực còn giữ của hợp đồng, tính từ các phiếu thu cọc trừ phần đã hoàn/bỏ. |
| **Tòa ảo "Chung"** | Một "toà" không có phòng thật, dùng để hạch toán các khoản dùng chung không thuộc toà cụ thể nào (ví dụ phiếu chia lợi nhuận cổ đông). Báo cáo theo toà thật thường loại trừ toà ảo này. |
| **Kỳ tháng `YYYY-MM`** | Cách ghi tháng chốt cho hoá đơn, chỉ số công tơ, chốt lợi nhuận — ví dụ `2026-07` là tháng 7/2026. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/contracts" view-only>

Mở app bằng tài khoản **demo.chunha** (chỉ xem, không sửa) và vào **Quản lý & Vận hành** => **Hợp đồng**:

- Nhìn cột trạng thái các hợp đồng: đối chiếu các nhãn **Còn hạn**, **Đã thanh lý**, **Hết hạn** với bảng **Trạng thái hợp đồng** ở trên.
- Tìm một hợp đồng có nhãn phụ "đã gia hạn": để ý nó **vẫn ở trạng thái Còn hạn** chứ không phải một trạng thái riêng — đúng như ghi chú `EXTENDED` đã ngưng dùng.
- Chuyển sang **Sơ đồ toà nhà** của **Tòa DEMO A**: đối chiếu màu/nhãn phòng **Trống**, **Đang thuê**, **Đã cọc/Giữ chỗ**, **Bảo trì** với bảng **Trạng thái phòng**.
- Mở một hoá đơn bất kỳ: xem nhãn **Đã duyệt / Đã thanh toán / Thu một phần** và badge hình thức **TM / TK** — khớp với các bảng ở trên.

</SandboxTry>

## Quy trình liên quan

- [Sandbox — Môi trường thực hành](/01-bat-dau/sandbox/) — danh sách tài khoản demo để tự đối chiếu trạng thái
- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — nơi gặp trạng thái hợp đồng
- [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) — nơi gặp trạng thái hoá đơn và hình thức thanh toán
- [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) — nơi gặp trạng thái cọc và trạng thái phòng Đã cọc
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) — phiếu thu/chi, hình thức TM/TK/TT/CT
- [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — thuật ngữ bàn giao và đối soát số sổ
- [Câu hỏi thường gặp](/07-thong-tin-khac/faq/) — giải đáp nhanh các thắc mắc khác
