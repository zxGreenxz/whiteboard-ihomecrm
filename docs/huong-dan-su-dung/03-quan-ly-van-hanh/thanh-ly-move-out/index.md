---
title: "Thanh lý hợp đồng — Khách rời phòng"
description: "Chốt số điện nước lần cuối, quyết toán công nợ và hoàn cọc khi khách trả phòng đúng quy trình; phòng về trống ngay trong một bước."
routes: ["/contracts/:id"]
permissions: [{module: contracts, action: terminate}]
viewport: desktop
audience: [quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Thanh lý hợp đồng — Khách rời phòng

Khi một khách **trả phòng đúng quy trình** (báo trước, dọn đi, bàn giao lại phòng), bạn dùng luồng **Khách rời phòng** để tất toán hợp đồng. Đây là hình thức thanh lý **êm đẹp**: hệ thống chốt **chỉ số điện nước lần cuối**, gộp mọi khoản khách còn nợ và các khoản **thu thêm** (tiền phòng những ngày ở nốt, tiền điện, tiền vệ sinh) rồi **cấn vào tiền cọc**. Phần cọc còn dư sau khi trừ nợ và khấu trừ được **hoàn lại cho khách**; phần cọc dùng để gạch nợ được ghi nhận thành **Doanh thu thanh lý** (tính vào kết quả kinh doanh — KQKD). Khác với luồng [Khách bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/), luồng này chạy **một bước** — mọi phiếu được duyệt ngay, hợp đồng đóng và **phòng về trống** liền, không phải bấm Duyệt lại.

::: danger Thanh lý là thao tác GHI TIỀN và KHÓ HOÀN TÁC
Bấm hoàn tất thanh lý sẽ **ghi phiếu thu/chi thật**, **gạch nợ mọi hoá đơn còn lại**, **chốt số điện vào công tơ** và **đóng hợp đồng** — tất cả duyệt ngay, không có bước xác nhận thứ hai để bạn kịp rút lại. Hãy kiểm tra kỹ **ngày chuyển đi**, **công nợ**, **số cọc hoàn trả** và **các khoản thu thêm** trước khi xác nhận. Trong tài liệu này bạn **chỉ thao tác trên hợp đồng bài tập phòng A202** ở sandbox, tuyệt đối không thanh lý hợp đồng thật.
:::

::: info Điều kiện tiên quyết
- Bạn có quyền **Hợp đồng => Thanh lý** (module `contracts`, action `terminate`) để thấy và bấm được nút **Thanh lý** trên màn chi tiết hợp đồng.
- Hợp đồng đang ở trạng thái còn hiệu lực (**ACTIVE**) — chưa **TERMINATED** hay **EXPIRED**, và còn gắn phòng/toà nhà.
- Nên **ghi chỉ số điện lần cuối** hoặc biết **số điện cuối kỳ** để chốt tiền điện chính xác (xem [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/)). Nếu bỏ trống, hệ thống vẫn cho thanh lý nhưng sẽ không có tiền điện cuối.
- Tiền cọc phải đang nằm ở **sổ CỌC (giữ hộ khách)** hoặc trên sổ thật đã thu; hệ thống tự bù cọc từ đó. Xem [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) và [Hoàn/bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào menu **Khách hàng => Hợp đồng**, mở **chi tiết hợp đồng** của phòng cần trả (bài tập: phòng **A202**, **Tòa DEMO A**). Trên thanh thao tác của màn chi tiết, bấm nút đỏ **Thanh lý**. Hộp thoại **Thanh lý hợp đồng** hiện ra với dòng *Chọn hình thức thanh lý hợp đồng* và **hai nút**: **Khách bỏ cọc** và **Khách rời phòng**. Cột phải màn hình vẫn cho bạn thấy khối **Tiền cọc** (Tổng tiền cọc, Đã thu, Còn lại) để đối chiếu số cọc đang giữ.

![Hộp thoại Thanh lý hợp đồng với hai nút Khách bỏ cọc và Khách rời phòng, cạnh khối Tiền cọc 4.000.000đ đã thu đủ](./images/buoc-01-dialog.webp)

**Bước 2**: Bấm **Khách rời phòng**. Form **Thanh lý — Khách rời phòng** mở ra, gồm bốn khối từ trên xuống:

- **THÔNG TIN HỢP ĐỒNG** — Mã HĐ, Khách hàng, **Phòng** (ví dụ *Tòa DEMO A - A202*), Ngày BĐ, Ngày KT và ô **Ngày chuyển đi** (bắt buộc, mặc định là hôm nay). Ngày chuyển đi này chính là **ngày kết thúc thực tế** ghi vào hợp đồng.
- **CÔNG NỢ KHÁCH HÀNG** — liệt kê các hoá đơn khách **chưa thanh toán**. Với A202 (cọc đủ, không nợ) khối này hiện *Không có hoá đơn chưa thanh toán*.
- **HOÀN CỌC VÀ TIỀN THỪA** — ô **Tiền cọc hoàn trả** (mặc định bằng tổng cọc, ví dụ **4.000.000đ**) và ô **Tiền phòng thừa** (tiền khách nộp dư còn lại — credit, tự điền nếu có).
- **THU THÊM** — *Các khoản khách phải trả thêm*: **Tiền phòng + Nước + PDV**, **Tiền điện**, **Tiền vệ sinh**.

![Form Thanh lý — Khách rời phòng: thông tin HĐ phòng A202, công nợ khách, hoàn cọc 4.000.000đ và khu Thu thêm với tiền phòng, tiền điện, tiền vệ sinh](./images/buoc-02-form.webp)

**Bước 3**: Kiểm tra **CÔNG NỢ KHÁCH HÀNG** và **Ngày chuyển đi**. Nếu còn hoá đơn chưa thu, chúng sẽ được **gạch nợ** trong lúc thanh lý (đánh dấu *Đã thu* bằng bút toán "Quyết toán khi thanh lý", **không huỷ** hoá đơn). Đặt đúng **Ngày chuyển đi** vì hệ thống dùng ngày này làm mốc tính số ngày ở nốt cho khoản **Tiền phòng + Nước + PDV** và ghi vào `actual_end_date` của hợp đồng.

**Bước 4**: Xem khối **HOÀN CỌC VÀ TIỀN THỪA**. Số **thực trả cho khách** không phải là cả cục cọc, mà được tính theo công thức:

> **Hoàn cọc thực = (Cọc hoàn trả + Tiền phòng thừa) − (Công nợ + Tổng thu thêm)**

- Phần cọc dùng để **bù nợ và các khoản thu thêm** sẽ được chuyển thành **Doanh thu thanh lý** trên **sổ vận hành của toà** và **tính vào KQKD**.
- Phần cọc **còn dư** sau khi trừ hết mới là tiền **hoàn trả thật** cho khách, chi ra từ **sổ CỌC** và **nằm ngoài KQKD** (trả lại tiền giữ hộ, không phải doanh thu).
- Nếu khấu trừ **vượt** số cọc (khách còn phải trả thêm), phần âm đó thành khoản **khách trả thêm**, ghi thu vào sổ vận hành và **tính vào KQKD**.

Với A202 cọc **4.000.000đ**, không nợ và chưa nhập thu thêm, ô **Tiền cọc hoàn trả** giữ nguyên **4.000.000đ** — đây là số sẽ chi trả lại khách.

**Bước 5**: Điền khu **THU THÊM** nếu khách còn phải trả các khoản cuối kỳ:

- **Tiền phòng + Nước + PDV** — tiền cho những ngày ở nốt trong tháng cuối, tính theo **khoảng ngày *Ở từ → đến*** (ô *đến* mặc định là ngày chuyển đi). Nhập số tiền hoặc để hệ thống prorate theo số ngày.
- **Tiền điện** — chốt điện cuối kỳ: nhập **Số cuối** (chỉ số công tơ lần cuối), hệ thống lấy số đầu từ lần ghi gần nhất và nhân đơn giá điện. Khoản này còn **ghi thẳng một bản chỉ số đã duyệt vào công tơ** (chốt số điện), nên bạn không cần ghi chỉ số riêng nữa.
- **Tiền vệ sinh** — mặc định **200.000đ**, sửa lại nếu cần.
- Có thể bấm **Thêm khoản** cho một mục tuỳ ý (tên + số tiền).

Mọi khoản thu thêm được **gộp chung vào một hoá đơn thanh lý** và **cấn trừ vào cọc** ngay (khác luồng bỏ cọc — nơi thu thêm ra một hoá đơn AR riêng chờ thu).

::: danger Xác nhận hoàn tất = ghi tiền và đóng hợp đồng ngay
Khi bạn bấm xác nhận thanh lý, hệ thống lập tức: (1) tạo/ghép **hoá đơn thanh lý** kèm các khoản thu thêm; (2) **gạch nợ mọi hoá đơn còn lại** về *Đã thu*; (3) chuyển phần cọc đã cấn thành **Doanh thu thanh lý** (vào KQKD) và **chi hoàn cọc dư** cho khách (ngoài KQKD); (4) **chốt số điện** vào công tơ; (5) đổi hợp đồng sang **TERMINATED** và **giải phóng phòng về trống**. Tất cả **duyệt ngay** — không có bước Duyệt thứ hai, nên **rất khó hoàn tác**. Chỉ bấm khi mọi con số đã đúng.
:::

**Bước 6**: Sau khi thanh lý xong, đối chiếu kết quả: hợp đồng chuyển **TERMINATED** với ngày kết thúc = ngày chuyển đi, **phòng về TRỐNG** (có thể cho khách mới), hoá đơn nợ cũ đã **Đã thu**, và có phiếu **chi hoàn cọc** cho khách cùng phiếu **Doanh thu thanh lý** (nếu có cấn nợ) trong [Thu chi](/03-quan-ly-van-hanh/thu-chi/) / [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/).

## Các tính năng khác trên màn hình

| Thành phần | Công dụng |
| --- | --- |
| Nút **Thanh lý** (đỏ) | Mở hộp thoại chọn hình thức thanh lý (Khách bỏ cọc / Khách rời phòng). |
| Nút **Khách rời phòng** | Chọn luồng MOVE_OUT — chốt điện, cấn nợ, hoàn cọc, phòng về trống (bài này). |
| Nút **Khách bỏ cọc** | Chọn luồng FORFEIT — khách bỏ ngang, mất cọc; xem [Thanh lý — Khách bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/). |
| Ô **Ngày chuyển đi** | Ngày kết thúc thực tế; mốc tính tiền phòng ở nốt và ghi vào hợp đồng. |
| Khối **CÔNG NỢ KHÁCH HÀNG** | Liệt kê hoá đơn chưa thanh toán sẽ được gạch nợ khi thanh lý. |
| Ô **Tiền cọc hoàn trả** | Số cọc đưa vào bù trừ (mặc định = tổng cọc); hệ thống trừ nợ + thu thêm để ra số hoàn thật. |
| Ô **Tiền phòng thừa** | Credit khách nộp dư còn lại, cộng vào nguồn bù cùng tiền cọc. |
| Khu **THU THÊM** | Tiền phòng+Nước+PDV theo ngày, Tiền điện (chốt công tơ), Tiền vệ sinh, khoản tuỳ ý. |
| Nút **Thêm khoản** | Thêm một dòng thu thêm tuỳ ý (tên + số tiền). |
| Khối **Tiền cọc** (cột phải) | Đối chiếu Tổng cọc / Đã thu / Còn lại của hợp đồng trước khi thanh lý. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách hiểu / xử lý |
| --- | --- |
| Không thấy nút **Thanh lý** | Bạn thiếu quyền **Hợp đồng => Thanh lý** (`contracts.terminate`), hoặc hợp đồng đã **TERMINATED/EXPIRED**. Nhờ chủ nhà cấp quyền. |
| Chọn nhầm **Khách bỏ cọc** | Đó là luồng giữ cọc làm phí phạt (khách mất cọc) và cần **bấm Duyệt** sau đó. Nếu khách trả phòng đúng quy trình, hãy dùng **Khách rời phòng**. Xem [Thanh lý — Khách bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/). |
| **Tiền hoàn trả nhỏ hơn** tổng cọc | Đúng thiết kế: cọc bị **cấn vào công nợ + thu thêm** trước, chỉ phần dư mới hoàn khách. Phần cấn thành Doanh thu thanh lý (vào KQKD). |
| Khấu trừ **vượt** cọc | Không hoàn trả; phần vượt trở thành khoản **khách trả thêm**, ghi thu vào sổ vận hành và tính KQKD. |
| Không nhớ **số điện cuối** | Có thể để trống ô Tiền điện — thanh lý vẫn chạy nhưng **không có tiền điện cuối**. Nên [ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) trước, hoặc nhập **Số cuối** ngay trong khu Thu thêm để chốt luôn. |
| Chốt số điện **không thấy** trong công tơ | Việc ghi chỉ số khi thanh lý là **best-effort** (bọc trong xử lý lỗi để không chặn thanh lý); nếu trùng/lỗi, bản ghi có thể không tạo — kiểm tra lại ở [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/). |
| Hoá đơn nợ cũ vẫn còn sau thanh lý | Move-out **gạch nợ** hoá đơn về *Đã thu* (bằng bút toán "Quyết toán khi thanh lý"), **không huỷ**. Chúng vẫn hiển thị nhưng đã tất toán. |
| Lỡ thanh lý nhầm | Rất khó hoàn tác vì mọi phiếu đã duyệt và phòng đã về trống. Liên hệ chủ nhà / kế toán để đảo bút toán thủ công; đừng tự sửa lẻ tẻ. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/contracts" app-label="Mở danh sách Hợp đồng" fixtures="Phòng A202 (Tòa DEMO A) hợp đồng ACTIVE, cọc đủ 4.000.000đ, không nợ">

Bài tập **an toàn** — bạn chỉ thao tác trên hợp đồng bài tập A202 và **không hoàn tất** (hoặc hoàn tất rồi Reset dữ liệu demo):

1. Mở **chi tiết hợp đồng** của phòng **A202** (Tòa DEMO A), bấm nút đỏ **Thanh lý**.
2. Trong hộp thoại, chọn **Khách rời phòng** để mở form **Thanh lý — Khách rời phòng**.
3. Quan sát khối **CÔNG NỢ KHÁCH HÀNG** hiện *Không có hoá đơn chưa thanh toán*, và ô **Tiền cọc hoàn trả** = **4.000.000đ** (vì cọc đủ, không nợ nên cọc được trả gần như trọn vẹn).
4. Xem khu **THU THÊM**: thử nhập **Số cuối** cho **Tiền điện** hoặc để **Tiền vệ sinh 200.000đ**, và để ý số **hoàn cọc thực** giảm đúng bằng phần thu thêm (cọc bị cấn trước).
5. **ĐÓNG hộp thoại (không bấm hoàn tất)** để không ghi tiền. Nếu bạn đã lỡ hoàn tất, hãy **Reset** dữ liệu demo về trạng thái ban đầu.

Kết quả mong đợi: bạn hiểu dòng tiền move-out — **cọc bù nợ + thu thêm ⇒ Doanh thu thanh lý (vào KQKD)**, **phần dư ⇒ hoàn trả khách (ngoài KQKD)**, mọi phiếu duyệt ngay và **phòng về trống** khi hoàn tất.

</SandboxTry>

## Quy trình liên quan

- [Thanh lý — Khách bỏ cọc](/03-quan-ly-van-hanh/thanh-ly-forfeit/) — luồng còn lại: khách bỏ ngang, giữ cọc làm phí phạt, phải bấm Duyệt sau.
- [Hoàn/bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/) — theo dõi tiền cọc, hoàn cọc và bỏ cọc theo hợp đồng.
- [Đặt cọc](/03-quan-ly-van-hanh/dat-coc/) — nguồn tiền cọc và credit dư dùng để bù trừ khi thanh lý.
- [Chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — nơi có nút Thanh lý và vòng đời hợp đồng.
- [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) — chốt chỉ số điện nước; thanh lý ghi thẳng số cuối vào công tơ.
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/) và [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) — nơi xem phiếu hoàn cọc và Doanh thu thanh lý phát sinh.
- [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/) — Doanh thu thanh lý vào KQKD, ảnh hưởng phân bổ lợi nhuận cổ đông.
- [Quy trình thanh lý](/01-bat-dau/quy-trinh-thanh-ly/) — bức tranh tổng quát về thanh lý hợp đồng.
