---
title: "Thanh lý hợp đồng — Khách bỏ cọc"
description: "Kết thúc hợp đồng khi khách bỏ ngang mất cọc: tịch thu cọc thành doanh thu, huỷ hoá đơn nợ cũ, và dùng Thu thêm để tạo hoá đơn AR đòi phần vượt cọc."
routes: ["/contracts/:id"]
permissions: [{module: contracts, action: terminate}]
viewport: desktop
audience: [quan-ly-toa, ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Thanh lý hợp đồng — Khách bỏ cọc

Khi khách **bỏ ngang, chịu mất cọc**, bạn thanh lý hợp đồng theo hình thức **Khách bỏ cọc** (forfeit). Đây là luồng ghi tiền: hệ thống **tịch thu phần cọc khách đã thực đóng** và chuyển thành doanh thu (phí phạt), đồng thời **huỷ toàn bộ hoá đơn còn nợ** của hợp đồng. Nếu bạn cần đòi thêm phần vượt quá cọc, khu **Thu thêm** sẽ tạo một **hoá đơn thu tiền khách riêng** để bạn theo dõi và thu sau. Trang này hướng dẫn mở form từ trang chi tiết hợp đồng, đọc đúng các con số, và nắm rõ dòng tiền của việc bỏ cọc.

::: info Điều kiện tiên quyết
- Quyền **Hợp đồng => Thanh lý** (module `contracts`, action `terminate`). Thao tác chỉ chạy khi bạn có quyền trên **toà của hợp đồng** — nếu không, bấm xác nhận sẽ bị hệ thống từ chối.
- Hợp đồng đang ở trạng thái **Đang hoạt động** (chưa **Thanh lý** / **Hết hạn**) và còn phòng, còn toà.
- Đã cấu hình **sổ CỌC** (`CỌC (giữ hộ khách)`) và **sổ vận hành** của toà để tiền cọc và doanh thu có chỗ chảy vào. Xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/).
- Hiểu trước hai cách tất toán cọc ở [Hoàn / bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/); nếu khách **trả phòng đúng quy trình và còn cọc phải trả lại**, dùng [Thanh lý — Khách rời phòng](/03-quan-ly-van-hanh/thanh-ly-move-out/) thay vì bỏ cọc.
:::

## Hướng dẫn từng bước

**Bước 1**: Mở trang chi tiết hợp đồng cần thanh lý. Từ menu **Khách hàng => Hợp đồng**, tìm dòng hợp đồng **A203** (khách **Ngô Văn Ích**, **Tòa DEMO A**) rồi ấn vào để mở. Đầu trang có một hàng nút thao tác vòng đời, trong đó có nút **Thanh lý**.

**Bước 2**: Ấn **Thanh lý** để mở hộp thoại **Thanh lý hợp đồng**. Ở bước đầu **Chọn hình thức thanh lý hợp đồng:**, ấn ô **Khách bỏ cọc** (ô đỏ, biểu tượng cấm) — dành cho trường hợp khách bỏ ngang, mất cọc.

**Bước 3**: Form **Thanh lý — Khách bỏ cọc** mở ra. Đọc ô **Ngày bỏ cọc** (bắt buộc, mặc định là hôm nay) — đây là ngày ghi nhận bỏ cọc và quyết định tháng của hoá đơn thanh lý.

![Form "Thanh lý — Khách bỏ cọc": ngày bỏ cọc, bảng hoá đơn sẽ bị huỷ, hộp giải thích, khu Thu thêm, và thẻ Tiền cọc / Tóm tắt hoá đơn bên phải](./images/buoc-01-form.webp)

**Bước 4**: Đọc khối **Hoá đơn sẽ bị huỷ**. Bảng liệt kê mọi hoá đơn còn nợ của hợp đồng theo cột **Mã HĐ**, **Kỳ**, **Tổng tiền**, **Đã TT**, **Còn nợ**. Với A203 có một hoá đơn quá hạn (ví dụ **INV-2026-00006**, kỳ **2026-06**, tổng **4.570.000đ**, đã TT **0**, còn nợ **4.570.000đ**), và dòng **Tổng còn nợ sẽ huỷ: 4.570.000đ**. Khi bỏ cọc, **toàn bộ phần nợ này bị xoá**: hoá đơn chưa thu chuyển về huỷ với tổng tiền 0; hoá đơn đã thu một phần thì giữ lại đúng phần đã thu làm doanh thu, chỉ xoá phần nợ.

**Bước 5**: Đọc hộp giải thích màu xanh, rồi nhìn sang thẻ **Tiền cọc** bên phải: **Tổng tiền cọc 4.000.000đ**, **Đã thu 4.000.000đ**, **Còn lại 0đ** (dòng **Đã thu đủ tiền cọc**). Phần **cọc khách đã thực đóng** (ở đây 4.000.000đ) sẽ bị **tịch thu → ghi nhận thành phí phạt = doanh thu bỏ cọc**. Hệ thống chỉ tịch thu phần cọc **đã thực đóng**, không tính phần khách còn nợ cọc — nên doanh thu bỏ cọc có thể **nhỏ hơn** tổng cọc ghi trên hợp đồng.

::: danger Bỏ cọc là thao tác ghi tiền và theo quy trình 2 bước
Khi bạn ấn **Lập hoá đơn & thanh lý**, hệ thống: huỷ hoá đơn nợ cũ, tạo **hoá đơn thanh lý** (một dòng phí phạt = cọc đã thực đóng), và tạo sẵn một **cặp phiếu "Doanh thu bỏ cọc" ở trạng thái chờ duyệt** rút từ **sổ CỌC**. Cọc **chưa** vào doanh thu (KQKD) và hoá đơn thanh lý **chưa** tất toán cho tới khi bạn vào **Tài chính => Thu chi**, tìm cặp phiếu đó và bấm **Duyệt**. Quên bấm **Duyệt** = doanh thu bỏ cọc bị thiếu trong Kết quả kinh doanh. Đây là tiền thật vào sổ và rất khó hoàn tác sau khi duyệt — chỉ thực hiện khi đã đối chiếu kỹ.
:::

**Bước 6**: Nếu cần **đòi thêm** phần vượt quá cọc (ở A203 nợ 4.570.000đ lớn hơn cọc 4.000.000đ, phần chênh **không** tự động được đòi vì hoá đơn nợ cũ đã bị huỷ), dùng khu **Thu thêm**. Nhập các khoản khách phải trả thêm:
- **Tiền phòng + Nước + PDV** theo khoảng **Ở từ** → **đến** (ô **đến** mặc định là ngày bỏ cọc) — hệ thống tính theo số ngày ở thực tế.
- **Tiền điện**: nhập **số đầu** → **Số cuối** để chốt số điện cuối kỳ.
- **Tiền vệ sinh** (mặc định **200.000đ**).
- **Thêm khoản** cho một khoản tuỳ ý (tên + số tiền).

Cuối khu hiện **Tổng thu thêm**. Khác với rời phòng, thu thêm khi **bỏ cọc** sẽ tạo một **hoá đơn thu tiền khách riêng** (ghi rõ dưới form: *"Sẽ tạo hoá đơn thu tiền khách riêng… tách biệt với hoá đơn thanh lý bù cọc vào doanh thu"*). Hoá đơn AR này **chờ bạn thu tiền khách thật** sau thanh lý ở [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — nó **không** được cấn vào cọc.

**Bước 7 (bài tập — không hoàn tất)**: Để chỉ tìm hiểu dòng tiền mà không ghi dữ liệu, ấn **Hủy** (hoặc dấu **✕** góc trên) để đóng form. Nút **Quay lại** đưa bạn về bước chọn hình thức nếu muốn xem lại luồng **Khách rời phòng**.

::: warning Nếu đã lỡ hoàn tất — và tuyệt đối không sửa ghi chú phiếu trước khi Duyệt
Thanh lý đóng hợp đồng thật (đổi trạng thái **Thanh lý**, giải phóng phòng) và rất khó hoàn tác. Trên sandbox, nếu bạn đã ấn **Lập hoá đơn & thanh lý**, dùng nút **Reset** của sandbox để trả A203 về **Đang hoạt động**.

Cặp phiếu chờ duyệt được nhận diện qua **nhãn ghi chú** (bắt đầu bằng `[CẤN CỌC BỎ CỌC …]`). **KHÔNG sửa ghi chú của phiếu trước khi bấm Duyệt** — máy trạng thái đọc đúng nhãn này để tự động duyệt cả cặp và ghi thanh toán cấn cọc; sửa nhãn đi thì cọc sẽ không vào doanh thu và hoá đơn thanh lý không tất toán.
:::

## Các tính năng khác trên màn hình

| Nút / Thành phần | Công dụng |
| --- | --- |
| **Ngày bỏ cọc** | Ngày ghi nhận bỏ cọc (mặc định hôm nay); quyết định tháng của hoá đơn thanh lý. |
| Bảng **Hoá đơn sẽ bị huỷ** | Liệt kê mọi hoá đơn còn nợ (Mã HĐ / Kỳ / Tổng tiền / Đã TT / Còn nợ) sẽ bị huỷ; dòng **Tổng còn nợ sẽ huỷ** cộng lại phần nợ. |
| Hộp giải thích (xanh) | Tóm tắt cơ chế bỏ cọc: huỷ nợ, cọc thành phí phạt, phiếu chờ duyệt rút từ sổ CỌC, bấm **Duyệt** mới vào KQKD. |
| Khu **Thu thêm** | Bốn khoản đòi thêm: **Tiền phòng + Nước + PDV** (theo **Ở từ** → **đến**), **Tiền điện** (số đầu → **Số cuối**), **Tiền vệ sinh**, **Thêm khoản** tuỳ ý; hiện **Tổng thu thêm**. |
| Thẻ **Tiền cọc** (phải) | **Tổng tiền cọc** / **Đã thu** / **Còn lại** — nguồn của phần cọc bị tịch thu. |
| Thẻ **Tóm tắt hóa đơn** (phải) | **Tổng hóa đơn** / **Tổng phát sinh** / **Đã thanh toán** / **Công nợ** của hợp đồng. |
| **Quay lại** | Về bước **Chọn hình thức thanh lý** (đổi sang **Khách rời phòng**). |
| **Hủy** | Đóng hộp thoại, không ghi gì. |
| **Lập hoá đơn & thanh lý** | Nút đỏ xác nhận: chạy thanh lý bỏ cọc (huỷ nợ, tạo hoá đơn thanh lý + cặp phiếu chờ duyệt, hoá đơn AR thu thêm nếu có). |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Bấm **Lập hoá đơn & thanh lý** báo **từ chối quyền** | Trang chi tiết vẫn hiện nút cho mọi toà, nhưng thao tác chỉ chạy khi bạn có quyền **Thanh lý** trên toà của hợp đồng. Nhờ người quản lý toà đó thực hiện, hoặc kiểm tra phân quyền. |
| Đã thanh lý nhưng **hoá đơn thanh lý chưa tất toán** / KQKD thiếu doanh thu bỏ cọc | Bỏ cọc theo **quy trình 2 bước**. Vào **Tài chính => Thu chi**, tìm cặp phiếu **"Doanh thu bỏ cọc"** (nhãn `[CẤN CỌC BỎ CỌC …]`) và bấm **Duyệt** — cọc mới vào doanh thu và hoá đơn thanh lý mới **PAID**. |
| **Cọc thành doanh thu ít hơn** tổng cọc trên hợp đồng | Đúng thiết kế: bỏ cọc chỉ tịch thu phần cọc **khách đã thực đóng**, không tính phần khách còn nợ cọc. |
| Nợ **lớn hơn** cọc, muốn thu phần vượt | Bỏ cọc huỷ hết hoá đơn nợ cũ và giữ cọc làm doanh thu; phần vượt **không** tự đòi. Dùng khu **Thu thêm** để tạo **hoá đơn thu tiền khách riêng**, rồi thu sau ở [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/). |
| Đã bấm **Duyệt** nhưng cọc vẫn không vào doanh thu | Kiểm tra **ghi chú** cặp phiếu có bị sửa không — máy trạng thái nhận diện qua nhãn `[CẤN CỌC BỎ CỌC …]`. Nếu nhãn bị đổi, đảo duyệt rồi khôi phục đúng nhãn, hoặc thanh lý lại. |
| Không thấy nút **Thanh lý** hoặc form báo lỗi | Hợp đồng đã **Thanh lý** / **Hết hạn**, hoặc chưa có phòng/toà. Chỉ thanh lý được hợp đồng **Đang hoạt động**. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.quanly" app-path="/contracts" app-label="Mở danh sách hợp đồng" fixtures="A203 còn hoá đơn quá hạn 4.570.000đ">

Tìm hiểu dòng tiền bỏ cọc trên hợp đồng **A203** (khách **Ngô Văn Ích**, **Tòa DEMO A**) — **không cần hoàn tất**:

1. Trong danh sách hợp đồng, tìm dòng **A203** và ấn để mở trang chi tiết.
2. Đầu trang, ấn **Thanh lý** → ở bước **Chọn hình thức thanh lý hợp đồng:** chọn **Khách bỏ cọc**.
3. Ở form **Thanh lý — Khách bỏ cọc**, đọc bảng **Hoá đơn sẽ bị huỷ** (nợ **4.570.000đ**) và thẻ **Tiền cọc** (đã thu **4.000.000đ**): hình dung cọc **4.000.000đ** bị tịch thu thành doanh thu, còn phần nợ vượt cọc bị huỷ.
4. Xem khu **Thu thêm**: để ý dòng dưới cùng báo sẽ tạo **hoá đơn thu tiền khách riêng** — cách đòi thêm phần vượt cọc.
5. Ấn **Hủy** (hoặc **✕**) để đóng mà không ghi dữ liệu. Nếu bạn lỡ ấn **Lập hoá đơn & thanh lý**, dùng nút **Reset** của sandbox để trả A203 về **Đang hoạt động**.

Kết quả mong đợi: bạn hiểu dòng tiền bỏ cọc — cọc thực đóng thành doanh thu (qua cặp phiếu **chờ duyệt** ở sổ thu chi), hoá đơn nợ cũ bị huỷ, và phần vượt cọc phải đòi bằng hoá đơn AR từ khu **Thu thêm**.

</SandboxTry>

## Quy trình liên quan

- [Hợp đồng chi tiết](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — nơi có nút **Thanh lý** mở hộp thoại này.
- [Thanh lý — Khách rời phòng](/03-quan-ly-van-hanh/thanh-ly-move-out/) — hình thức còn lại: khách trả phòng đúng quy trình, còn cọc phải trả lại.
- [Hoàn / bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/) — tra soát các khoản đã hoàn/bỏ cọc sau thanh lý.
- [Thu chi & Sổ quỹ](/03-quan-ly-van-hanh/thu-chi/) — nơi bấm **Duyệt** cặp phiếu "Doanh thu bỏ cọc" để hoàn tất bước 2.
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — thu hoá đơn AR "thu thêm" sinh ra khi bỏ cọc.
- [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) — sổ CỌC (giữ hộ khách) và sổ vận hành, hai đầu của dòng tiền bỏ cọc.
- [Đặt cọc giữ chỗ](/03-quan-ly-van-hanh/dat-coc/) — nguồn của số cọc bị tịch thu.
- [Chia lợi nhuận](/03-quan-ly-van-hanh/chia-loi-nhuan/) — doanh thu bỏ cọc vào KQKD nên ảnh hưởng phân bổ lợi nhuận cổ đông.
- [Quy trình thanh lý](/01-bat-dau/quy-trinh-thanh-ly/) — vị trí bước thanh lý trong toàn bộ vòng đời khách thuê.
