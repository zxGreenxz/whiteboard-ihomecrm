---
title: "Sổ quỹ (vận hành)"
description: "Xem giao dịch và số dư tồn quỹ từng sổ, chia sẻ sổ cho đồng nghiệp, và hiểu các sổ ảo tiền thối / làm tròn / cấn trừ."
routes: ["/finance/cashbooks"]
permissions: [{module: cashbooks, action: view}]
viewport: desktop
audience: [ke-toan]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Sổ quỹ (vận hành)

Sổ quỹ là nơi mọi đồng tiền vào/ra hệ thống đáp xuống: thu tiền phòng, thu phí phạt, chi sửa chữa, hoàn cọc, bàn giao tiền mặt... Mỗi phiếu thu hay phiếu chi đều nằm trong đúng một sổ quỹ. Trang này giúp bạn **xem giao dịch của từng sổ, theo dõi số dư tồn quỹ, chia sẻ sổ cho người khác** và nhận ra các **sổ ảo** mà hệ thống tự sinh (tiền thối, làm tròn, cọc giữ hộ khách, cấn trừ thanh lý). Đây là màn *vận hành* — khác với bước tạo sổ ban đầu ở [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/).

Nguyên tắc cốt lõi bạn cần nhớ: **Tồn quỹ = Số dư đầu kỳ + tổng phiếu THU đã duyệt − tổng phiếu CHI đã duyệt**. Chỉ phiếu đã **duyệt** mới được tính; phiếu nháp hay phiếu đã huỷ không cộng vào.

::: info Điều kiện tiên quyết
- Quyền xem **Sổ quỹ** (`cashbooks.view`) — thường là chủ nhà hoặc kế toán.
- Đã có ít nhất một sổ quỹ trong hệ thống (xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/)).
- Nên có sẵn vài phiếu thu/chi đã ghi để có giao dịch mà đối chiếu (xem [Thu chi](/03-quan-ly-van-hanh/thu-chi/) và [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/)).
:::

## Hướng dẫn từng bước

**Bước 1**: Vào **Tài chính** => **Sổ quỹ**. Bạn thấy danh sách toàn bộ sổ quỹ, mỗi dòng có: **Mã** sổ, cột **Thao tác**, **Tên sổ quỹ**, **Phụ trách** (người chịu trách nhiệm sổ), **Số dư đầu kỳ**, **Tồn quỹ** (số dư hiện tại) và **Ghi chú**. Trong dữ liệu demo có ba sổ mẫu: **DEMO Ngân Hàng**, **DEMO Quản Lý Thu** và **DEMO Sale Thu**.

![Màn Sổ quỹ liệt kê DEMO Ngân Hàng, DEMO Quản Lý Thu, DEMO Sale Thu kèm số dư đầu kỳ và tồn quỹ](./images/buoc-01-danh-sach.webp)

**Bước 2**: Đọc hai cột số dư để hiểu ý nghĩa. **Số dư đầu kỳ** là mốc bạn khai lúc bắt đầu dùng phần mềm (số tiền thực có trong ví/tài khoản tại ngày chốt đầu kỳ). **Tồn quỹ** là số dư *hiện tại*, do hệ thống tự tính = số dư đầu kỳ cộng dồn mọi phiếu thu/chi đã duyệt. Số âm (màu đỏ) nghĩa là sổ đã chi nhiều hơn thu — bình thường với sổ ngân hàng đang tạm ứng chi.

**Bước 3**: Mở một sổ để xem chi tiết giao dịch. Ở cột **Thao tác**, ấn nút **con mắt** (Xem thu chi) trên dòng sổ muốn xem. Hệ thống mở màn **Thu chi** đã **lọc sẵn theo đúng sổ đó**, liệt kê từng phiếu thu (PT...) và phiếu chi (PC...) đã ghi vào sổ, kèm ngày, hạng mục và số tiền. Đây là nơi bạn thấy "sổ quỹ tổng hợp mọi phiếu" một cách trực quan.

**Bước 4**: Đối chiếu số dư. Cộng nhẩm: **Số dư đầu kỳ + tổng THU đã duyệt − tổng CHI đã duyệt** phải bằng đúng **Tồn quỹ** hiển thị ở Bước 1. Ví dụ với **DEMO Ngân Hàng**: số dư đầu kỳ **0đ**, có một phiếu thu phí phạt **200.000đ** và một phiếu chi sửa chữa **500.000đ** đã duyệt ⇒ tồn quỹ = 0 + 200.000 − 500.000 = **-300.000đ**, khớp với con số đỏ trên màn hình. Nếu con số của bạn không khớp, hãy rà lại danh sách phiếu (thường là còn phiếu **nháp** chưa duyệt hoặc phiếu đã **huỷ** lẫn vào cách bạn cộng).

::: danger Số dư chỉ phản ánh phiếu ĐÃ DUYỆT — đừng "sửa" tồn quỹ cho khớp bằng tay
Tồn quỹ là con số *dẫn xuất*, không nhập tay. Nó chỉ thay đổi khi có **thao tác ghi tiền thật**: thu tiền khách, ghi phiếu chi, duyệt một phiếu nháp, hay thu tiền hoá đơn. Muốn số dư đổi thì phải sửa ở **phiếu** (màn Thu chi / Thu tiền), không phải ở màn Sổ quỹ. Không bao giờ chỉnh số dư đầu kỳ chỉ để "cho khớp" — làm vậy là che giấu sai lệch thật của dòng tiền.
:::

::: tip Sổ ảo (kỹ thuật) — có mặt để hạch toán cho đúng, số dư thật nằm ở nơi khác
Ngoài các sổ tiền thật, hệ thống tự sinh vài **sổ ảo** để ghi nhận nghiệp vụ đặc biệt. Bạn sẽ gặp chúng trong danh sách:

- **X Thối** (ví dụ "Tâm Thối"): ghi lại **tiền thối trả khách** khi thu tiền mặt. Đây chỉ là ledger ghi nhận — tiền thối **đã được trừ (net) sẵn trong tổng thu** của phiếu, nên sổ này không trừ thêm tiền thật.
- **Làm tròn tiền thiếu**: khi khách còn thiếu **dưới 10.000đ**, hệ thống "tha" phần lẻ và ghi vào sổ này để hoá đơn vẫn tính là đã thu đủ. Chỉ có một sổ Làm tròn dùng chung.
- **CỌC (giữ hộ khách)**: giữ tiền cọc của mọi khách; khi thanh lý sẽ chi trả khách và chuyển phần cấn nợ sang sổ vận hành. Số dư sổ này về **0 cho mỗi hợp đồng** sau khi thanh lý xong.
- **Cấn trừ thanh lý (nội bộ)**: sổ kỹ thuật cho bút toán **cấn trừ công nợ** (mã `CT`) khi thanh lý — không phải tiền mặt, chỉ gạch nợ; số dư luôn cân về 0.
:::

## Các tính năng khác trên màn hình

| Nút / Cột | Công dụng |
| --- | --- |
| **Thêm sổ quỹ** | Tạo sổ quỹ mới (tiền mặt / ngân hàng). Chi tiết ở [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/). |
| **Con mắt** (Xem thu chi) | Mở màn Thu chi đã lọc sẵn theo sổ — xem toàn bộ giao dịch của sổ đó. |
| **Ổ khoá** (Khoá / Mở khoá) | Đặt ngày khoá sổ; chặn lập/sửa/xoá mọi phiếu có ngày phát sinh nằm trong kỳ đã chốt. |
| **Bút chì** (Sửa) | Mở form sổ để đổi tên, số dư đầu kỳ, thông tin ngân hàng, toà mặc định và danh sách người được phép dùng. |
| **Thùng rác** (Xoá) | Xoá mềm sổ quỹ (chỉ khi bạn có quyền). |
| **Ô tìm kiếm** | Lọc nhanh theo **mã** hoặc **tên** sổ quỹ. |
| **Người được phép sử dụng** (trong form Sửa) | Chia sẻ sổ cho đồng nghiệp cùng xem/ghi phiếu, kể cả khi họ không quản lý toà nhà gắn với sổ. |
| **Phụ trách** | Người chịu trách nhiệm sổ; quyết định sổ nào được tự chọn khi người đó thu tiền mặt. |
| **Số dư đầu kỳ** | Mốc khởi điểm; mọi phiếu đã duyệt cộng/trừ từ mốc này ra Tồn quỹ. |

::: warning Khoá sổ và xoá sổ khó hoàn tác — cân nhắc trước khi bấm
**Khoá sổ** sẽ chặn cả việc lập lẫn sửa/xoá phiếu trong kỳ đã chốt — nếu lỡ khoá nhầm ngày, các thao tác thu chi hợp lệ sau đó sẽ bị từ chối cho tới khi bạn mở khoá lại. **Xoá sổ** khiến sổ biến mất khỏi danh sách và các lựa chọn thu tiền. Chỉ khoá khi đã thực sự chốt số kỳ đó, và chỉ xoá sổ trống không còn được dùng.
:::

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Tồn quỹ không khớp số tiền tôi cộng tay | Nhớ rằng chỉ phiếu **đã duyệt** mới tính; loại các phiếu **nháp** (UNAPPROVED) và **đã huỷ** ra khỏi phép cộng. Số dư đầu kỳ cũng phải đúng. |
| Số dư sổ hiển thị cho tôi thấy, nhưng danh sách phiếu lại thiếu | Đây là chủ ý: số dư (Tồn quỹ) hiển thị cho mọi người, còn **danh sách phiếu** chỉ hiện các phiếu bạn có quyền theo toà nhà. Nếu cần thấy đủ phiếu, nhờ chủ sổ chia sẻ sổ cho bạn. |
| Không lập được phiếu cho một ngày cũ | Sổ đã bị **khoá** tới ngày đó; mở khoá (nếu có quyền) hoặc chọn ngày phát sinh sau ngày khoá. |
| Đồng nghiệp không thấy giao dịch của một sổ | Mở form **Sửa** sổ, thêm họ vào khối **Người được phép sử dụng** rồi Lưu. |
| Tồn quỹ sổ "X Thối" hoặc "Làm tròn" bằng 0 dù đã thu nhiều | Đúng như thiết kế — hai sổ này chỉ là ledger ghi nhận, tiền thối đã net sẵn trong phiếu thu nên không trừ thật. |
| Muốn xem riêng nhật ký tiền thối / làm tròn | Xem trang chuyên biệt ở [Tiền thối & làm tròn](/03-quan-ly-van-hanh/tien-thua/) — ô lọc sổ ở màn Thu chi không bắt được sổ Làm tròn. |
| Đổi tên sổ "…Thu" xong hệ thống chọn sai sổ khi thu tiền | Phần mềm nhận diện sổ thu qua **tên kết thúc bằng "Thu"** và tên sổ "Làm tròn tiền thiếu" / "Chung"; đừng đổi tên các sổ đặc biệt này khi chưa rà kỹ. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/finance/cashbooks" app-label="Mở màn Sổ quỹ" fixtures="DEMO Ngân Hàng, DEMO Quản Lý Thu, DEMO Sale Thu" view-only>

1. Ở màn **Sổ quỹ**, xem ba sổ demo và ghi nhớ cột **Tồn quỹ**. Để ý **DEMO Ngân Hàng** đang ở **-300.000đ**.
2. Trên dòng **DEMO Ngân Hàng**, ấn nút **con mắt** (Xem thu chi) để mở màn Thu chi đã lọc sẵn theo sổ này. Bạn thấy hai giao dịch đã ghi ở các bài trước: một phiếu **thu phí phạt 200.000đ** và một phiếu **chi sửa chữa 500.000đ**.
3. Đối chiếu: 0đ (đầu kỳ) + 200.000đ (thu) − 500.000đ (chi) = **-300.000đ** — đúng bằng Tồn quỹ.
4. Quay lại và mở thử một sổ **…Thu** để so sánh: các khoản thu tiền hoá đơn của khách (ví dụ đã thu ở [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/)) sẽ hiện thành phiếu thu trong sổ.

Kết quả mong đợi: bạn hiểu **sổ quỹ tổng hợp mọi phiếu thu/chi** — Tồn quỹ luôn là số dư đầu kỳ cộng dồn các phiếu đã duyệt, và mở một sổ ra là thấy đúng những giao dịch làm nên con số đó.

</SandboxTry>

## Quy trình liên quan

- [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/) — cách tạo sổ mới, đặt số dư đầu kỳ và quy ước đặt tên.
- [Thu chi](/03-quan-ly-van-hanh/thu-chi/) — lập/sửa/huỷ từng phiếu thu, phiếu chi làm thay đổi số dư sổ.
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) — thu tiền khách tạo phiếu thu mirror rơi vào sổ quỹ.
- [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) — chốt số sổ và bàn giao tiền mặt giữa nhân viên với chủ.
- [Tiền thối & làm tròn](/03-quan-ly-van-hanh/tien-thua/) — nhật ký chi tiết của các sổ ảo tiền thối và làm tròn tiền thiếu.
