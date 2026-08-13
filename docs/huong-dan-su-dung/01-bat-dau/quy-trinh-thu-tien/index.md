---
title: "Quy trình: Chu kỳ thu tiền hàng tháng"
description: "Sổ tay chu kỳ thu tiền từ chỉ số đến thu và đối soát, kèm checkpoint thủ công cho kỳ thiếu, chỉ số trùng và credit khách."
routes: []
permissions: []
viewport: desktop
audience: [ke-toan, quan-ly-toa]
captured:
  date: "2026-07-03"
  account: demo
status: published
---

# Quy trình: Chu kỳ thu tiền hàng tháng

Trang này là SOP các bước bạn lặp lại **mỗi tháng**: ghi chỉ số, lập hoá đơn, gửi khách, thu tiền và đối soát. Hiện hệ thống **không có scheduler bảo đảm sinh đủ mọi kỳ**, đường ghi chỉ số/hoá đơn còn nhiều writer và màn báo cáo tiền thừa không phải ledger credit canonical. Vì vậy chu kỳ chỉ kết thúc khi checklist đối soát đã xanh, không chỉ khi đã bấm "Sinh hoá đơn".

::: info Điều kiện tiên quyết
Trước khi bắt đầu một kỳ thu tiền, toà nhà của bạn cần có sẵn:

- **Công tơ điện/nước** đã gắn cho từng phòng — xem [Công tơ & đồng hồ](/01-bat-dau/cong-to/).
- **Dịch vụ & định mức** (điện, nước, rác, phí quản lý…) đã khai báo đơn giá — xem [Dịch vụ & định mức](/01-bat-dau/dich-vu-dinh-muc/).
- **Hợp đồng đang hiệu lực** cho các phòng cần thu — xem [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/).
- **Sổ quỹ & loại thu chi** để tiền thu vào có chỗ ghi nhận — xem [Sổ quỹ & loại thu chi](/01-bat-dau/so-quy-loai-thu-chi/).

Bạn cần `meter_readings.view/create`, `invoices.view/create/approve`, `thu_tien.view/collect` hoặc `invoices.record_payment`, cùng quyền sổ quỹ liên quan trên toà tương ứng.
:::

::: warning Ba kiểm soát thủ công bắt buộc
- Trước khi lập hoá đơn: rà một phòng chỉ có **một chỉ số active cho mỗi công tơ/kỳ**; production đã có nhóm chỉ số trùng.
- Sau khi lập: đối chiếu **mọi hợp đồng active phải có kỳ cần thu**. Toggle "tự sinh hoá đơn" hiện không có scheduler chạy nền đáng tin.
- Sau khi thu: dùng chi tiết collection/payment và ledger credit của hợp đồng để đối chiếu. Không dùng riêng báo cáo **Tiền thừa** hoặc cột "Ai thu bao nhiêu" làm nguồn quyết định vì các reader này còn lệch với credit/reversal canonical.
:::

## Hướng dẫn từng bước

Toàn bộ chu kỳ một tháng chảy theo sơ đồ dưới đây. Mỗi khối là một bước, và mỗi bước có một trang chi tiết riêng.

```mermaid
flowchart TD
    A["Bước 1 · Ghi chỉ số điện/nước<br/>(meter_readings kỳ YYYY-MM)"] --> B["Bước 2 · Sinh hoá đơn hàng loạt<br/>(cả toà, 1 lần bấm)"]
    B --> C["Bước 3 · Kiểm tra & gửi hoá đơn / QR"]
    C --> D{"Khách trả bao nhiêu?"}
    D -->|Trả đủ| E["Bước 4 · Thu tiền TM/TT/TK → hoá đơn PAID"]
    D -->|Trả một phần| F["PARTIAL_PAID — phần còn thiếu<br/>carry sang hoá đơn kỳ sau (previous_debt)"]
    D -->|Trả thừa| G["Ghi tiền thừa (credit theo hợp đồng)"]
    E --> H["Bước 5 · Xử lý thừa/nợ + tiền vào sổ quỹ"]
    F --> H
    G --> H
    H --> I["Bước 6 · Bàn giao tiền & đối soát sổ"]
    I --> J(["Kết thúc kỳ → sang tháng sau"])
    J -.lặp lại.-> A
```

**Bước 1**: Ghi chỉ số điện/nước cho kỳ. Vào **Ghi chỉ số**, chọn toà và tháng, nhập số công tơ hiện tại. Các đường ghi hiện có thể tạo thẳng trạng thái **Đã duyệt**, nên badge duyệt không đủ chứng minh dữ liệu duy nhất. Trước Bước 2, lọc theo phòng/công tơ/kỳ và xử lý mọi dòng trùng hoặc số cuối bất thường. Chi tiết: [Ghi chỉ số điện nước](/03-quan-ly-van-hanh/ghi-chi-so/).

::: tip
Ghi chỉ số cố định vào cùng một ngày mỗi tháng (ví dụ ngày cuối tháng) để lượng tiêu thụ giữa các kỳ so sánh được và khách không thắc mắc về số ngày lệch.
:::

**Bước 2**: Sinh hoá đơn cho kỳ và theo dõi kết quả **từng phòng**. Preview được dựng từ dữ liệu phía client; writer hiện chưa tự ràng buộc chặt trạng thái hợp đồng, phòng và kỳ. Rà đúng hợp đồng active, đúng phòng và kỳ nằm trong thời hạn thuê trước khi lưu. Chi tiết: [Sinh hoá đơn hàng loạt](/03-quan-ly-van-hanh/sinh-hoa-don/).

::: warning
Sinh hoá đơn tạo chứng từ công nợ thật cho khách. Kiểm tra kỹ đã chọn **đúng tháng** và **đúng toà** trước khi bấm — sửa lại sau khi đã sinh sẽ mất công huỷ/tạo lại từng hoá đơn. Mỗi hợp đồng chỉ được một hoá đơn đang hiệu lực cho mỗi tháng.
:::

::: danger Không có "tự sinh kỳ sau" đáng tin
Cài đặt hiện có nhãn tự sinh nhưng không có scheduler đảm bảo chạy. Sau mỗi lượt, hãy lập danh sách hợp đồng active của toà và đánh dấu: **đã có kỳ / được miễn-hoãn / cần xử lý ngoại lệ**. Không dùng riêng Báo cáo Lịch thanh toán để kết luận vì reader hiện có thể đọc hoá đơn huỷ/xoá và bị cắt khi quá 1.000 dòng.
:::

**Bước 3**: Kiểm tra và gửi hoá đơn cho khách. Mở danh sách [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) để rà soát toàn kỳ, hoặc mở [Chi tiết hoá đơn](/03-quan-ly-van-hanh/hoa-don-chi-tiet/) của từng phòng để xem từng dòng, in, hoặc lấy **mã QR / link thanh toán** gửi khách. Ở màn này bạn xác nhận số tiền, hạn thanh toán và nội dung trước khi khách trả.

**Bước 4**: Thu tiền khi khách thanh toán. Có ba đường thu, cùng ghi vào một chỗ:

- **Thu trên chi tiết hoá đơn** (máy tính): mở [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/), nhập số tiền, chọn hình thức **TM** / **TT** / **TK** và sổ quỹ nhận tiền. Đây là đường duy nhất thu được hoá đơn tháng đầu có gộp cọc.
- **Thu nhanh trên điện thoại**: dùng [Thu tiền trên điện thoại](/03-quan-ly-van-hanh/thu-tien-mobile/) khi đi thu tại chỗ — chỉ thu **TM**, tự chọn sổ "…Thu" và làm tròn phần thiếu nhỏ.
- **Thu hàng loạt**: chọn nhiều hoá đơn và thu một lượt (không dùng cho hoá đơn gộp cọc).

Sau khi thu, trạng thái hoá đơn tự chuyển **PAID** (đủ) hoặc **PARTIAL_PAID** (một phần), và một **phiếu thu** được ghi vào sổ quỹ tương ứng.

::: danger
Thu tiền là thao tác **ghi tiền thật** vào sổ quỹ và làm thay đổi công nợ khách. Trước khi bấm xác nhận, đối chiếu lại **số tiền**, **hình thức TM/TT/TK** và **sổ quỹ nhận** — ghi nhầm sổ hoặc nhầm hình thức sẽ làm lệch số dư và phải điều chỉnh thủ công. Giữ nguyên mã **TM** / **TT** / **TK** như phần mềm hiển thị, không tự dịch sang chữ.
:::

**Bước 5**: Xử lý tiền thừa và nợ còn lại. Nếu khách trả **thừa**, phần dư được ghi thành **credit theo hợp đồng** để trừ vào kỳ sau. Hãy đối chiếu credit còn hiệu lực trên hợp đồng/phiếu thu; trang [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) chỉ là một góc nhìn báo cáo và hiện có thể lệch ledger credit canonical. Nếu khách trả **thiếu**, phần còn lại nằm ở trạng thái nợ và được đưa vào quy trình kỳ sau. Các khoản thu/chi lẻ ngoài hoá đơn ghi ở [Thu chi](/03-quan-ly-van-hanh/thu-chi/); số dư quỹ xem ở [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/).

**Bước 6**: Bàn giao tiền mặt và đối soát sổ. Cuối ngày/cuối đợt, tiền mặt nhân viên đang giữ được **nộp lên** cho quản lý hoặc chủ, rồi hai bên **đối soát số dư sổ**. Đây là một quy trình riêng — xem [Quy trình bàn giao](/01-bat-dau/quy-trinh-ban-giao/) để nắm các bước, và [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/) để thao tác trên màn hình.

### Ghi nhớ nghiệp vụ quan trọng

- **Cọc gộp trong hoá đơn tháng đầu**: khi khách còn thiếu tiền cọc lúc ký hợp đồng, phần cọc thiếu **không** là một phiếu thu lẻ ngoài hoá đơn — nó được thêm thành một dòng **"Tiền cọc"** ngay trong **hoá đơn tháng đầu**. Vì vậy hoá đơn tháng đầu phải thu qua màn hình chi tiết hoá đơn (Bước 4, đường đầu tiên), không thu qua thu hàng loạt/thu nhanh.
- **Phiếu thu tách hạng mục — cọc không vào doanh thu**: mỗi lần thu tạo **đúng một phiếu thu**, nhưng nếu hoá đơn có gộp cọc thì phiếu tự tách hạng mục **"Tiền cọc" (is_deposit)**. Phần cọc này **không** được tính vào Kết quả kinh doanh (KQKD) — nó là tiền giữ hộ khách, chỉ phần tiền phòng/dịch vụ mới là doanh thu.
- **Nợ cũ tự cộng dồn (carry)**: hoá đơn kỳ mới tự cộng phần **nợ kỳ trước** của phòng đó vào tổng, kèm ghi nguồn nợ. Bạn không phải cộng tay.
- **Làm tròn tổng hoá đơn**: xét riêng 3 chữ số cuối; phần lẻ **dưới 900đ** được làm tròn xuống, từ **900đ trở lên** được làm tròn lên bội 1.000đ. Ví dụ `1.299.500đ → 1.299.000đ`, còn `1.299.900đ → 1.300.000đ`.
- **Làm tròn tiền thiếu dưới 10.000đ khi thu**: khi phần còn lại dương nhưng nhỏ hơn 10.000đ, hệ thống có thể khép hoá đơn và ghi phần làm tròn vào sổ ảo. Cơ chế này **không được bỏ qua phần cọc còn thiếu** trong hoá đơn.
- **Không kéo nợ vụn sang kỳ sau**: khi tính `previous_debt`, residual dưới 10.000đ bị loại khỏi phần carry-over; đây là cơ chế khác với hai bước làm tròn trên.
- **Tiền thối đã net trong tổng thu**: nếu có ghi nhận tiền thối lại cho khách, số tiền đó đã được trừ sẵn — **tổng thu của phiếu là số ròng**, đừng trừ thêm lần nữa.

## Các tính năng khác trên màn hình

| Tính năng | Ở màn nào | Dùng để làm gì |
|---|---|---|
| Nhập chỉ số hàng loạt (Excel) | [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) | Nhập nhanh số công tơ nhiều phòng cùng lúc |
| Xem lượng tiêu thụ so kỳ trước | [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/) | Phát hiện phòng dùng điện/nước bất thường trước khi ra hoá đơn |
| Chỉnh dòng hoá đơn từng phòng | [Chi tiết hoá đơn](/03-quan-ly-van-hanh/hoa-don-chi-tiet/) | Sửa số tiền, thêm/bớt dịch vụ trước khi khách trả |
| In hoá đơn / lấy QR thanh toán | [Hoá đơn](/03-quan-ly-van-hanh/hoa-don/) | Gửi khách qua ảnh/QR để chuyển khoản |
| Thu tiền tại chỗ trên điện thoại | [Thu tiền trên điện thoại](/03-quan-ly-van-hanh/thu-tien-mobile/) | Đi thu tiền mặt ngoài hiện trường, tự vào sổ |
| Theo dõi & trừ tiền thừa | [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) | Giữ credit của khách để bù kỳ sau |
| Ghi thu/chi lẻ ngoài hoá đơn | [Thu chi](/03-quan-ly-van-hanh/thu-chi/) | Phí phạt, sửa chữa, các khoản không qua hoá đơn |
| Xem số dư từng quỹ | [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/) | Kiểm tra tồn quỹ trước khi bàn giao |

## Tình huống & lỗi thường gặp

| Tình huống | Vì sao | Cách xử lý |
|---|---|---|
| Sinh hoá đơn nhưng phòng bị thiếu tiền điện/nước | Chỉ số kỳ đó chưa **Đã duyệt** hoặc chưa ghi | Quay lại [Ghi chỉ số](/03-quan-ly-van-hanh/ghi-chi-so/), ghi/duyệt chỉ số rồi sinh lại hoá đơn phòng đó |
| Hoá đơn tháng đầu không thu được qua thu nhanh/thu hàng loạt | Hoá đơn có **gộp cọc**, hai đường này từ chối | Thu qua [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) trên chi tiết hoá đơn |
| Tổng hoá đơn lệch vài trăm đồng so với tính tay | Hệ thống xét 3 chữ số cuối: **< 900đ làm xuống, ≥ 900đ làm lên** bội 1.000đ | Bình thường — đối chiếu trên tổng cuối cùng, không làm tròn từng dòng |
| Thu đủ nhưng hoá đơn vẫn còn nợ nhỏ | Có ghi **tiền thối**, hoặc còn lẻ < 10.000đ | Kiểm tra dòng tiền thối (đã net trong tổng thu); phần < 10.000đ được tự làm tròn khi thu |
| Khách trả thừa, không biết tiền đi đâu | Phần thừa thành **credit theo hợp đồng** | Xem và dùng lại ở [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) cho kỳ sau |
| Đã bật tự sinh nhưng một số phòng không có hoá đơn | Toggle hiện chưa có scheduler bảo đảm | Lập queue hợp đồng/kỳ thiếu, kiểm từng phòng và sinh bù sau khi xác nhận điều khoản, chỉ số và trạng thái |
| Báo cáo Lịch thanh toán/Tiền thừa khác chi tiết hợp đồng | Reader báo cáo còn giới hạn nguồn/trạng thái | Ưu tiên hoá đơn active, collection/payment và credit của hợp đồng; báo ngoại lệ nếu chưa khớp |
| Ghi nhầm hình thức TM/TT/TK | Chọn sai lúc thu | Điều chỉnh phiếu thu ở [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/); giữ nguyên mã TM/TT/TK, không tự dịch |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.ketoan" app-path="/meter-readings" app-label="Mở Ghi chỉ số (sandbox kế toán)" fixtures="Snapshot 13/08/2026: Ghi chỉ số, Hoá đơn và Thu tiền đang không có bản ghi đủ điều kiện để thực hành thu." view-only>
Đi theo chuỗi **ghi chỉ số → sinh hoá đơn → thu tiền** ở chế độ chỉ xem và đọc đúng trạng thái đang hiển thị:

1. Mở **Ghi chỉ số**. Nếu danh sách rỗng, xác nhận đây là empty state của kỳ/phạm vi hiện tại; không tự suy ra chỉ số từ fixture cũ.
2. Sang **Sinh hoá đơn** và **Hoá đơn**. Khi chưa có chỉ số hoặc kỳ hoá đơn phù hợp, ghi nhận điều kiện còn thiếu thay vì bấm sinh chứng từ thử.
3. Sang **Thu tiền hoá đơn**. Snapshot ngày 13/08/2026 không có hoá đơn đủ điều kiện để thu; kiểm tra bộ lọc toà/kỳ và giữ nguyên dữ liệu.

Khi dữ liệu thật xuất hiện, chọn một bản ghi ngay trên màn hình rồi đối chiếu các dòng tiền, trạng thái và sổ quỹ theo checklist ở trên. Không dùng mã phòng hay số tiền cố định trong các bản demo cũ.
</SandboxTry>

## Quy trình liên quan

- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — từ khách hẹn, đặt cọc đến ký hợp đồng (đầu vào của chu kỳ thu tiền).
- [Quy trình bàn giao](/01-bat-dau/quy-trinh-ban-giao/) — nộp tiền và đối soát sổ sau khi thu.
- [Ghi chỉ số điện nước](/03-quan-ly-van-hanh/ghi-chi-so/)
- [Sinh hoá đơn hàng loạt](/03-quan-ly-van-hanh/sinh-hoa-don/)
- [Danh sách hoá đơn](/03-quan-ly-van-hanh/hoa-don/) · [Chi tiết hoá đơn](/03-quan-ly-van-hanh/hoa-don-chi-tiet/)
- [Thu tiền hoá đơn](/03-quan-ly-van-hanh/thu-tien-hoa-don/) · [Thu tiền trên điện thoại](/03-quan-ly-van-hanh/thu-tien-mobile/)
- [Tiền thừa](/03-quan-ly-van-hanh/tien-thua/) · [Thu chi](/03-quan-ly-van-hanh/thu-chi/) · [Sổ quỹ](/03-quan-ly-van-hanh/so-quy/)
- [Bàn giao & đối soát](/03-quan-ly-van-hanh/ban-giao-doi-soat/)
