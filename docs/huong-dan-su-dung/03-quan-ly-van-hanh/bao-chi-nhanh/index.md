---
title: "Báo chi nhanh — ghi chi bằng tin nhắn, giọng nói, ảnh bill"
description: "Gõ, nói hoặc chụp bill là có thẻ nháp phiếu chi (hoặc khoản chi cá nhân); soát lại rồi bấm Lưu. AI chỉ giúp điền, không tự lưu."
routes: ["/chi-tieu"]
permissions: [{module: income_expenses, action: create}, {module: personal_finance, action: create}]
viewport: mobile
audience: [quan-ly-toa, ke-toan, chu-nha]
captured:
  date: "2026-10-01"
  account: nguyentam
status: published
---

# Báo chi nhanh

Màn **Báo chi nhanh** cho bạn ghi một khoản chi trong vài giây: **gõ một câu**, **nói**, hoặc **chụp bill**. Mỗi khoản thành một **thẻ nháp** hiện ngay trên màn — bạn soát, sửa ô nào chưa đúng, rồi bấm **Lưu**. Không có gì được ghi khi bạn chưa bấm Lưu.

- Khoản **công ty** thành **phiếu chi** y như lập ở màn [Thu chi](/03-quan-ly-van-hanh/thu-chi/): cùng sổ quỹ, cùng hạng mục, cùng luật duyệt.
- Khoản **cá nhân** ghi vào [Ví thu chi cá nhân](/03-quan-ly-van-hanh/vi-ca-nhan/) — không chạm sổ sách công ty.

::: info Mở màn ở đâu
- **Điện thoại**: màn hình chính, nhóm **Tài chính**, ô **Báo chi nhanh**.
- **Máy tính**: menu **Tài chính → Báo chi nhanh**.
- Ô và mục menu hiện với người có quyền **Thu chi ⇒ Tạo**. Người chỉ có quyền Ví cá nhân mở bằng đường dẫn `/chi-tieu`.
:::

## Chọn ghi vào Công ty hay Cá nhân

Có cả hai quyền thì ngay trên ô nhập có hai nút **Công ty** | **Cá nhân**. Màn nhớ lựa chọn lần trước của bạn. Chỉ có một quyền thì không có hai nút này.

## Cách 1 — Gõ một câu

Gõ như nhắn tin rồi bấm **Gửi** (hoặc Enter). Ví dụ:

| Bạn gõ | Thẻ nháp |
| --- | --- |
| `102LVT sơn 300k, keo 20k` | Toà 102LVT, hai dòng: sơn 300.000đ, keo 20.000đ |
| `hôm qua sửa điện p301 405PVB 350 nghìn` | Ngày hôm qua, toà 405PVB phòng 301, 350.000đ |
| `bún bò 50k, xăng 100k` (Cá nhân) | Hai dòng ví cá nhân |

Máy đọc được `50k`, `1tr2` (1,2 triệu), `1 triệu 2`, `1.200.000`, `một trăm hai mươi nghìn`, `ba lít` (300 nghìn), `hôm qua`, `25/9`, `tháng 9`, mã toà và số phòng. Một câu nhắc nhiều toà hoặc nhiều phòng thì tách thành nhiều thẻ — mỗi thẻ một phiếu.

## Cách 2 — Nói

1. Ô nhập đang trống thì nút bên phải là **micro** — chạm vào và cho phép trình duyệt dùng micro (lần đầu).
2. Nói câu như khi gõ (tối đa 30 giây), rồi chạm **Xong**. Chạm **✕** để huỷ.
3. Chữ hiện vào ô nhập — **soát lại số tiền và tên toà**, sửa nếu nghe nhầm, rồi bấm **Gửi**.

Âm thanh chỉ dùng để chuyển thành chữ, **không được lưu**. Máy không ghi âm được (hoặc giọng nói đang tắt) thì màn gợi ý dùng **nút micro trên bàn phím điện thoại**.

## Cách 3 — Chụp hoặc chọn ảnh bill

Chạm biểu tượng **máy ảnh** để chụp, hoặc **ảnh** để chọn từ thư viện; trên máy tính có thể **dán ảnh** (Ctrl+V) vào ô nhập. AI đọc tổng tiền, cửa hàng, ngày, từng món; bill điện nước thì đọc thêm **mã khách hàng** và **kỳ** để tự tìm toà và hạng mục.

- Ảnh khoản **công ty** được lưu làm **chứng từ** của phiếu khi bạn bấm Lưu.
- Ảnh khoản **cá nhân** chỉ để AI đọc, **không lưu**.
- Tổng các món lệch số tiền thực trả (phí ship, giảm giá…) thì thẻ ghi **một dòng bằng số thực trả** và nhắc bạn kiểm lại.

## Soát thẻ rồi Lưu

Thẻ công ty có: **Ngày chi**, **Người nhận / cửa hàng**, **Toà**, **Phòng** (hoặc *Cả toà (không gắn phòng)*), **Sổ quỹ chi tiền**, các dòng (mô tả, hạng mục, số tiền). Thẻ có dấu **AI đọc — soát lại** là thẻ AI đã điền giúp — xem kỹ trước khi lưu. Ô bạn đã tự sửa thì AI không bao giờ ghi đè.

- Sổ quỹ chọn sẵn trong các sổ **bạn được chi**. Chưa được giao sổ nào thì thẻ báo rõ và không lưu được phiếu công ty — nhờ quản trị giao sổ.
- Kỳ này toà đã có phiếu cùng hạng mục thì thẻ nhắc mã phiếu đó để bạn khỏi chi trùng (chỉ nhắc, không chặn).

Bấm **Lưu phiếu chi** (công ty) hoặc **Lưu vào ví** (cá nhân). Kết quả:

| Thẻ hiện | Nghĩa là |
| --- | --- |
| **Đã lưu PC… · Đã duyệt** / **Chờ duyệt** | Phiếu đã tạo; trạng thái duyệt do luật chi của công ty quyết, y như phiếu lập tay. Bấm **Xem trong Thu chi** để mở. |
| **Đã ghi vào Ví cá nhân** | Khoản cá nhân đã ghi. |
| Thẻ khoá + **Gửi lại y nguyên** | Mất mạng giữa chừng, chưa biết đã lưu chưa. Bấm **Gửi lại y nguyên** — với phiếu công ty, hệ thống nhận ra lần gửi trước nên **không tạo phiếu thứ hai**. Hoặc **Kiểm tra trong Thu chi**. |
| Lỗi đỏ | Bị từ chối (vd thiếu quyền ở toà đó) — sửa rồi lưu lại. |

Thẻ chưa lưu được giữ lại khi bạn tải lại trang (trong 48 giờ, trên chính máy đó). Riêng thẻ từ ảnh bill công ty mà chưa lưu thì không giữ được ảnh — chụp lại.

## Khi AI không giúp được

AI chỉ là phần trợ giúp. Khi AI tắt, hết lượt trong ngày (150 lượt/người/ngày — mỗi lần chuyển giọng nói, mỗi thẻ cần AI đọc và mỗi ảnh tính một lượt) hoặc lỗi, màn vẫn **nhập tay được bình thường**: bạn điền thẳng vào thẻ rồi Lưu. Tin chữ lỗi AI tạm thời thì có nút **Thử AI lại**.
