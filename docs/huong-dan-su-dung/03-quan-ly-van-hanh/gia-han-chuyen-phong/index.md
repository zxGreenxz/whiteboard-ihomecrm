---
title: "Gia hạn & chuyển phòng"
description: "Gia hạn hợp đồng đang hiệu lực và chuyển hợp đồng sang phòng khác trong cùng toà, với các bước kiểm tra giá, cọc và quyền sở hữu khách."
routes: ["/contracts/:id"]
permissions: [{module: contracts, action: renew}, {module: contracts, action: transfer}]
viewport: desktop
audience: [quan-ly-toa]
captured:
  date: "2026-08-13"
  commit: "ca1104137123942e27c1aa6b41147b256be59e82"
  account: demo.chunha
status: published
---

# Gia hạn & chuyển phòng

Trang này hướng dẫn hai thao tác biến động hợp đồng thường gặp nhất: **gia hạn** khi hợp đồng sắp hết hạn nhưng khách muốn ở tiếp, và **chuyển phòng** khi khách đổi sang một phòng khác **trong cùng toà**. Cả hai đều mở từ trang chi tiết hợp đồng và thay đổi trực tiếp dòng hợp đồng hiện tại.

::: info Điều kiện tiên quyết
- **Gia hạn** cần `contracts.renew`; **Chuyển phòng** cần `contracts.transfer`, cùng phạm vi toà của hợp đồng.
- Hợp đồng phải **đang hiệu lực** (trạng thái **ACTIVE**). Riêng **Gia hạn** còn bật cho hợp đồng **sắp hết hạn** hoặc **đã quá hạn**; **Chuyển phòng** chỉ bật khi hợp đồng còn hiệu lực.
- Muốn chuyển phòng: phải có sẵn **phòng trống** ở toà đích (phòng đang có khách hoặc đang giữ cọc sẽ không hiện trong danh sách chọn).
- Là nhân viên, bạn chỉ thao tác được trên hợp đồng thuộc toà được gán phạm vi cho mình.
:::

::: warning Gia hạn KHÔNG đổi trạng thái hợp đồng
Khi gia hạn, hợp đồng **giữ nguyên trạng thái ACTIVE** — hệ thống chỉ đẩy **ngày kết thúc** ra xa hơn và ghi một dòng vào lịch sử gia hạn. Mô hình cũ (đổi sang trạng thái "EXTENDED") **đã bỏ từ 2026-06-06**. Vì vậy đừng tìm một trạng thái riêng cho hợp đồng đã gia hạn: dấu hiệu **"Đã gia hạn"** là một chip xanh dương suy ra từ lịch sử gia hạn, hiển thị cạnh trạng thái ở đầu trang chi tiết.
:::

## Hướng dẫn từng bước

**Bước 1**: Mở **trang chi tiết** hợp đồng cần xử lý — từ menu **Hợp đồng**, ấn vào dòng hợp đồng trong danh sách. Trên đầu trang chi tiết, khi hợp đồng còn hiệu lực bạn sẽ thấy các nút thao tác vòng đời: **Gia hạn**, **Chuyển phòng**, **Nhượng HĐ**, **Đăng ký chuyển đi**, **Thanh lý**.

![Trang chi tiết hợp đồng — nơi mở nút Gia hạn và Chuyển phòng](./images/buoc-01-chi-tiet.webp)

### Gia hạn hợp đồng

**Bước 2**: Ấn **Gia hạn**. Hộp thoại **Gia hạn hợp đồng** mở ra, hiển thị sẵn **Ngày kết thúc hiện tại** (chỉ đọc) để bạn đối chiếu.

**Bước 3**: Điền **Ngày kết thúc mới** (bắt buộc) — phải muộn hơn ngày kết thúc hiện tại. Các ô **Giá thuê mới** và **Tiền cọc mới** được điền sẵn theo hợp đồng hiện tại; xem và xác nhận chúng thay vì giả định ô trống nghĩa là giữ nguyên. Không hạ nghĩa vụ cọc xuống dưới số khách đã thực nộp nếu chưa có quyết định rõ ràng về phần chênh và bút toán hoàn/chuyển tương ứng. Thêm **Ghi chú** nếu cần, rồi ấn **Gia hạn**.

**Bước 4**: Hệ thống cập nhật ngày kết thúc, giá thuê và nghĩa vụ cọc trực tiếp trên cùng dòng hợp đồng, rồi ghi lịch sử gia hạn. Hiện chưa có bảng điều khoản hiệu lực theo thời gian hoặc khoá cạnh tranh chắc chắn cho hai người gia hạn cùng lúc. Vì vậy chỉ một người thao tác, tải lại ngay sau lưu và đối chiếu giá/cọc/ngày cuối cùng; hợp đồng vẫn ở trạng thái **ACTIVE**.

::: tip Số tháng gia hạn được tính tự động
Bạn chỉ cần chọn **ngày kết thúc mới**; hệ thống tự suy ra số tháng gia hạn từ khoảng cách so với ngày kết thúc cũ và lưu vào lịch sử. Muốn gia hạn thêm 6 tháng, chỉ việc đặt ngày kết thúc mới muộn hơn khoảng 6 tháng.
:::

### Chuyển phòng

**Bước 5**: Quay lại trang chi tiết, ấn **Chuyển phòng**. Hộp thoại **Chuyển phòng** hiện một khung tóm tắt tình trạng hiện tại: **Khách hàng**, **Toà nhà**, **Phòng** và **Giá thuê hiện tại**.

**Bước 6**: Chuyển phòng hiện chỉ được hỗ trợ **trong cùng toà**. Chọn **Phòng mới** đang Trống của chính toà hiện tại; nếu giao diện cho thấy một toà khác, server vẫn từ chối chuyển chéo toà. Nhu cầu chuyển sang toà khác phải được xử lý như một ngoại lệ nghiệp vụ, không thử lách bằng nút này.

**Bước 7**: Nếu phòng mới có giá khác, điền **Giá thuê mới** (để trống thì giữ nguyên giá cũ). Chọn **Ngày chuyển** (mặc định là hôm nay), thêm **Ghi chú** nếu cần, rồi ấn **Chuyển phòng**.

**Bước 8**: Hệ thống chuyển hợp đồng sang phòng mới, cập nhật giá thuê (nếu có nhập), nối ghi chú, và ghi một dòng vào **lịch sử chuyển phòng**. Trạng thái hợp đồng **giữ nguyên ACTIVE**. **Phòng cũ tự về Trống**, **phòng mới thành Đang thuê**.

::: warning Chuyển phòng có hiệu lực ngay và khó hoàn tác
Ngay khi bạn ấn **Chuyển phòng**, phòng cũ được giải phóng về **Trống** và phòng mới bị chiếm thành **Đang thuê**. Không có nút "hoàn tác": nếu chuyển nhầm, bạn phải mở lại **Chuyển phòng** và chuyển ngược về phòng cũ (khi phòng cũ vẫn còn trống). Hãy kiểm tra kỹ toà và phòng đích trước khi xác nhận.
:::

::: warning Phân biệt chuyển phòng với nhượng/chuyển khách
**Chuyển phòng** giữ nguyên hợp đồng và khách, chỉ đổi phòng trong cùng toà; RPC có kiểm tra cạnh tranh phòng. **Nhượng HĐ/chuyển khách** đổi người sở hữu nghiệp vụ nhưng hiện không tự phân bổ/tất toán cọc, nợ, hoá đơn hoặc credit và thiếu kiểm tra khách cùng tổ chức ở một số đường đi. Chỉ thực hiện nhượng sau khi có biên bản xác định quyền sở hữu từng khoản và đối soát thủ công toàn bộ số dư.
:::

::: warning Báo cáo biến động có thể thiếu sự kiện
Báo cáo gia hạn/chuyển phòng hiện không bao phủ chắc chắn mọi sự kiện chuyển đã hoàn tất. Xác nhận kết quả tại chính hợp đồng, phòng cũ/phòng mới và lịch sử liên quan; không dùng một báo cáo trống để kết luận chưa chuyển.
:::

## Các tính năng khác trên màn hình

| Nút / Ô nhập | Công dụng |
| --- | --- |
| **Gia hạn** (header chi tiết) | Mở hộp thoại gia hạn; bật khi hợp đồng đang hiệu lực, sắp hết hạn hoặc đã quá hạn. |
| **Chuyển phòng** (header chi tiết) | Mở hộp thoại chuyển phòng; chỉ bật khi hợp đồng còn hiệu lực. |
| Ô **Ngày kết thúc hiện tại** | Chỉ đọc — hiển thị mốc kết thúc đang áp dụng để bạn đối chiếu trước khi gia hạn. |
| Ô **Ngày kết thúc mới** | Bắt buộc khi gia hạn; phải muộn hơn ngày kết thúc hiện tại. |
| Ô **Giá thuê mới** / **Tiền cọc mới** | Được điền sẵn khi gia hạn; giá trị lưu sẽ thay trực tiếp giá/cọc hiện hành của hợp đồng. |
| Toà đích | Chuyển phòng chỉ hỗ trợ **cùng toà**; chuyển chéo toà bị server từ chối. |
| Ô **Phòng mới** | Chỉ liệt kê phòng đang **Trống** của toà đã chọn. |
| Ô **Ngày chuyển** | Mốc chuyển phòng, mặc định là ngày hiện tại. |
| Ô **Ghi chú** | Ghi chú kèm theo, được nối vào phần ghi chú của hợp đồng. |
| Chip **"Đã gia hạn"** | Dấu hiệu ở đầu trang chi tiết cho biết hợp đồng đã từng gia hạn (suy từ lịch sử gia hạn). |
| Tab **Lịch sử** | Xem lại các lần gia hạn / chuyển phòng / thanh lý của hợp đồng theo dòng thời gian. |

## Tình huống & lỗi thường gặp

| Tình huống | Cách xử lý |
| --- | --- |
| Không thấy nút **Gia hạn** / **Chuyển phòng** | Nút chỉ hiện khi hợp đồng còn hiệu lực (và với gia hạn thì cả khi sắp/đã hết hạn). Hợp đồng đã **Thanh lý** thì không còn hai nút này. Nhân viên ngoài phạm vi toà bấm vào sẽ bị hệ thống từ chối (lỗi quyền). |
| Gia hạn báo lỗi ngày kết thúc | **Ngày kết thúc mới** phải muộn hơn ngày kết thúc hiện tại. Lỗi này chỉ hiện qua thông báo sau khi ấn **Gia hạn**, nên hãy kiểm tra lại ngày trước khi bấm. |
| Ô **Phòng mới** trống rỗng, không có phòng để chọn | Toà đích chưa có phòng nào **Trống**. Chọn toà khác, hoặc giải phóng/duyệt xong một phòng trước (phòng đang có khách hoặc đang giữ cọc không hiện ở đây). |
| Đã gia hạn nhưng trạng thái vẫn là **ACTIVE** | Đúng thiết kế — gia hạn **giữ nguyên ACTIVE**. Hãy nhìn chip **"Đã gia hạn"** ở đầu trang chi tiết và ngày kết thúc mới để xác nhận, đừng tìm một trạng thái "đã gia hạn" riêng. |
| Danh sách **Hợp đồng** chưa hiện dấu "đã gia hạn" | Chip **"Đã gia hạn"** hiện tại chỉ hiển thị ở **đầu trang chi tiết**, chưa hiển thị ngoài danh sách. Mở chi tiết hợp đồng để xem. |
| Chuyển nhầm phòng | Mở lại **Chuyển phòng** và chuyển ngược về phòng cũ (nếu phòng cũ vẫn còn trống). Không có nút hoàn tác tự động. |
| Báo cáo không thấy lần chuyển vừa làm | Đối chiếu trực tiếp hợp đồng, phòng cũ/phòng mới và lịch sử; báo cáo hiện có thể bỏ sót sự kiện chuyển thật. |
| Cần đổi khách đại diện thay vì đổi phòng | Đây là **Nhượng HĐ/chuyển khách**, không phải Chuyển phòng. Phải chốt rõ quyền sở hữu cọc, nợ, hoá đơn và credit trước vì hệ thống chưa tự chuyển đầy đủ các khoản này. |
| Sau chuyển phòng, phòng cũ vẫn báo **Đang thuê** | Kiểm tra lại phòng cũ có còn hợp đồng hiệu lực nào khác không. Với thao tác chuyển phòng chuẩn, phòng cũ tự về **Trống** ngay khi xác nhận. |

## Thử trực tiếp trên sandbox

<SandboxTry account="demo.chunha" app-path="/contracts" app-label="Mở danh sách Hợp đồng" fixtures="Snapshot 13/08/2026: 20 hợp đồng, nhóm Sắp hết hạn có 4 bản ghi." view-only>

Quan sát luồng gia hạn mà không lưu thay đổi:

1. Lọc nhóm **Sắp hết hạn** và mở một bản ghi đang hiển thị. Ghi nhớ **Mã hợp đồng**, phòng và **Ngày kết thúc hiện tại**.
2. Ấn **Gia hạn** để xem form, kiểm tra ngày hiện tại cùng các trường giá thuê/cọc được điền sẵn.
3. Không nhập và không bấm lưu; đóng form. Trong nghiệp vụ thật, sau khi lưu phải tải lại và xác nhận hợp đồng vẫn `ACTIVE`, ngày mới đúng và lịch sử đã ghi.

Kết quả mong đợi: bạn hiểu rằng gia hạn cập nhật hợp đồng hiện tại và giữ trạng thái `ACTIVE`; không phụ thuộc mã phòng fixture cũ.

</SandboxTry>

## Quy trình liên quan

- [Hợp đồng](/03-quan-ly-van-hanh/hop-dong/) — danh sách hợp đồng, nơi cũng mở được Gia hạn / Chuyển phòng cho từng dòng.
- [Chi tiết hợp đồng](/03-quan-ly-van-hanh/hop-dong-chi-tiet/) — trang chi tiết 5 tab, gốc mở các thao tác vòng đời và xem tab Lịch sử.
- [Hoàn / bỏ cọc](/03-quan-ly-van-hanh/hoan-bo-coc/) — xử lý tiền cọc khi kết thúc hoặc bỏ cọc hợp đồng.
- [Căn hộ / Phòng](/03-quan-ly-van-hanh/can-ho-phong/) — trạng thái phòng tự đổi theo hợp đồng: phòng cũ về Trống, phòng mới thành Đang thuê.
- [Quy trình khách thuê](/01-bat-dau/quy-trinh-khach-thue/) — vòng đời khách thuê từ đặt cọc, ký hợp đồng đến gia hạn và thanh lý.
