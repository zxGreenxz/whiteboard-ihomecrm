# Bỏ cọc giữ chỗ chưa gắn hợp đồng — thiết kế

Ngày: 2026-09-10. Trạng thái: thiết kế để rà soát, chưa triển khai.

Người dùng đã chọn: xử lý bỏ toàn bộ hoặc giữ một phần; phần trả lại khách hỗ trợ cả hoàn ngay và hoàn sau.

## 1. Mục tiêu và thao tác

Từ chi tiết phiếu thu hoặc danh sách Phiếu giữ chỗ, chọn **Xử lý bỏ cọc**. Dùng chung một hộp thoại trên desktop và mobile:

| Trường | Hành vi |
|---|---|
| Phiếu / khách / phòng | Chỉ xem, lấy từ phiếu nguồn |
| Cọc thực nhận còn xử lý được | Server tính; chỉ phần cọc, không lấy tổng phiếu trộn |
| Hoàn lại khách | Mặc định 0đ, từ 0 đến cọc thực nhận |
| Giữ lại → doanh thu | Tự tính = cọc thực nhận − tiền hoàn |
| Ngày xử lý | Hôm nay theo tổ chức; không trước ngày nhận, không ở tương lai |
| Lý do | Chọn Khách đổi ý / Không đến ký hợp đồng / Khác; Khác phải nhập nội dung |
| Hoàn ngay / Hoàn sau | Chỉ xuất hiện khi tiền hoàn > 0 |
| Sổ quỹ chi và xác nhận đã trả | Chỉ cần khi hoàn ngay; sổ thật mà người thao tác có quyền |

Nút chính: **Xác nhận xử lý**. Số tiền hiển thị trước khi xác nhận luôn là số server đã đối chiếu.

- Bỏ toàn bộ: hai lần bấm trong trường hợp thông thường, không cần nhập tiền.
- Hoàn một phần: nhập tiền hoàn, phần giữ lại tự đổi.
- Hoàn ngay: ghi nhận khoản tiền người dùng đã thực trả; ứng dụng không tự chuyển tiền ngân hàng.
- Hoàn sau: tạo nghĩa vụ phải trả khách, không bắt chọn sổ và không làm giảm quỹ.
- Trên khoản Chờ hoàn có nút **Hoàn tiền**: chọn sổ, ngày chi, xác nhận đã trả rồi ghi sổ đúng số còn phải hoàn.
- V1 xử lý từng phiếu; không tự gom các phiếu theo phòng hoặc tên người nộp. Nếu phòng có phiếu khác đang giữ chỗ, nêu rõ lý do chưa trả phòng về trống.
- Cho phép hoàn toàn bộ bằng cùng hộp thoại; khi giữ lại = 0, nhãn kết quả là **Đã hoàn cọc** hoặc **Chờ hoàn cọc**, không ghi doanh thu 0đ thành một phiếu mới.

## 2. Kết quả nghiệp vụ

Ví dụ: cọc thực nhận 3.000.000đ, hoàn 1.000.000đ, giữ 2.000.000đ.

| Chỉ tiêu | Hoàn ngay | Hoàn sau |
|---|---:|---:|
| Doanh thu theo ngày xử lý | 2.000.000đ | 2.000.000đ |
| Cọc còn dùng cho hợp đồng mới từ phiếu này | 0đ | 0đ |
| Phải trả khách còn lại | 0đ | 1.000.000đ |
| Thay đổi tiền quỹ lúc xử lý | −1.000.000đ | 0đ |
| Thay đổi tiền quỹ khi hoàn sau | Không phát sinh thêm | −1.000.000đ |

Phần giữ lại được ghi nhận doanh thu bằng nghiệp vụ không tiền; không sinh lần thu tiền thứ hai. Hoàn tiền cọc làm giảm khoản phải trả khách, không trở thành chi phí làm giảm doanh thu bỏ cọc.

Ngay khi xử lý thành công, phiếu nguồn hết hiệu lực giữ chỗ và hết khả năng dùng làm cọc hợp đồng mới, kể cả còn Chờ hoàn. Phòng trở về trạng thái phù hợp:

- Không còn ràng buộc: Trống, xuất hiện lại trong danh sách phòng trống.
- Còn cọc giữ chỗ khác: vẫn giữ chỗ.
- Còn hợp đồng hiệu lực: không đổi thành Trống; phòng sắp trống có thể xuất hiện lại theo quy tắc hiện hành.
- Bảo trì / ngưng sử dụng: giữ nguyên.
- Khóa giữ chỗ 24h có bằng chứng thuộc lần đặt cọc này: kết thúc cùng nghiệp vụ. Khóa khác hoặc chưa xác định được chủ thể: giữ lại, trả lý do rõ; không hủy toàn bộ khóa của phòng.

## 3. Lưu lịch sử và trạng thái

Giữ nguyên phiếu thu ban đầu, ngày nhận và chứng từ nhận tiền. Tạo hồ sơ xử lý liên kết theo id phiếu.

Hai trạng thái độc lập:

- Xử lý cọc: chưa xử lý / đã xử lý, kèm số giữ lại và số phải hoàn.
- Hoàn tiền: không cần hoàn / chờ hoàn / đã hoàn.

Nhãn người dùng:
- Giữ toàn bộ: **Đã bỏ cọc**.
- Giữ một phần: **Đã bỏ cọc một phần**, thêm **Chờ hoàn 1.000.000đ** hoặc **Đã hoàn 1.000.000đ**.
- Giữ lại 0: **Chờ hoàn cọc** / **Đã hoàn cọc**.

Không dùng approval_status=CANCELLED để biểu diễn bỏ cọc; hủy phiếu thu có nghĩa khác với việc công ty giữ lại tiền đã nhận.

Ngày, người xử lý, lý do, số tiền và phiếu hoàn đều truy vết được từ phiếu gốc. Cọc đã xử lý không xuất hiện trong việc cần ký hợp đồng / bổ sung cọc. Khoản Chờ hoàn có danh sách riêng trong màn cọc hiện có, hiển thị dù chưa có ngày hẹn; không ép vào hàng đợi quá hạn vốn yêu cầu mốc ngày.

## 4. Mô hình và quy tắc tiền

### 4.1. Cơ chế đối ứng được đề xuất

Không đổi hạng mục cọc hoặc bật cờ hạch toán KQKD trên phiếu thu gốc. Trạng thái hiển thị “đã bỏ cọc” được lấy từ hồ sơ liên kết, không sửa trục duyệt của phiếu.

Với cọc 3 triệu, giữ 2 triệu và hoàn 1 triệu:

| Chứng từ | Loại / hạng mục | Số tiền | KQKD | Tiền quỹ |
|---|---|---:|---:|---:|
| Phiếu thu gốc | INCOME / DEPOSIT, giữ nguyên | 3.000.000đ | 0đ | Giữ lần nhận tiền gốc |
| Giảm cọc do khách bỏ | EXPENSE / DEPOSIT, nội bộ | 2.000.000đ | 0đ | 0đ |
| Doanh thu bỏ cọc | INCOME / REVENUE, nội bộ | 2.000.000đ | +2.000.000đ | 0đ |
| Phiếu chi hoàn khi thực trả | EXPENSE / DEPOSIT, tiền thật | 1.000.000đ | 0đ | −1.000.000đ |

Hai dòng nội bộ là cặp đối ứng cùng số tiền giữ lại, cùng ngày xử lý, cùng hồ sơ. Chỉ chân doanh thu mới bật tính KQKD; chân giảm cọc luôn ngoài KQKD. Cả hai khai NON_CASH / NOT_APPLICABLE, dùng sổ nội bộ theo chuẩn hiện hành, không có cash posting và không làm thay đổi số dư quỹ thật ở cả mô hình v1/v2.

Hoàn sau: sau cặp đối ứng vẫn còn khoản phải trả khách 1 triệu, dù toàn bộ phiếu nguồn không còn dùng để giữ phòng hay ký hợp đồng. Khi trả tiền, phiếu chi giảm đúng khoản phải trả này. Không lấy tiền hoàn làm chi phí để trừ doanh thu 2 triệu.

Các bút toán do server tự tạo sau một lần xác nhận, không thêm thao tác lập phiếu thủ công. Đây là phương án thiết kế đang trao đổi; chưa thực hiện thay đổi dữ liệu.

### 4.2. Hồ sơ và các bất biến

Thêm bảng hồ sơ public.reservation_deposit_settlements, một hồ sơ cho một phiếu nguồn. Hồ sơ chốt số tiền bất biến; trạng thái hoàn suy ra từ phiếu chi và bút toán tiền đang có hiệu lực.

Trường chính: id, organization_id, source_voucher_id (unique), building_id, room_id, deposit_amount, retained_amount, refund_amount, settlement_date, reason_code, reason_text, created_by, created_at, basis_fingerprint, revenue_voucher_id, offset_voucher_id, refund_voucher_id, reservation_hold_id (nullable).

Bất biến:
- deposit_amount = retained_amount + refund_amount; mọi số là VND nguyên không âm, deposit_amount > 0.
- Một phiếu đã gắn hợp đồng, đã bị tiêu dùng, đã hủy, đã hoàn tác tiền nhận hoặc chưa thực nhận đủ không được xử lý.
- Phiếu Finance V2 phải có bằng chứng posting tiền nhận còn hiệu lực. Không suy tiền thật từ APPROVED.
- Cọc legacy phải qua adapter đối chiếu đường nhận tiền đang dùng; phiếu sổ ảo / giữ chỗ tượng trưng 1đ không được tự suy thành tiền thật. Không có nút ép nhận tiền trong tính năng này.
- Phiếu trộn chỉ lấy tổng item cọc được phân loại thống nhất. Nếu phân loại cũ/mới mâu thuẫn, chặn và yêu cầu đối chiếu.
- Số giữ lại tạo nghiệp vụ nội bộ riêng reservation.forfeit_revenue / reservation.forfeit_offset; không giả tạo contract_terminations hoặc hợp đồng/hóa đơn thanh lý.
- Số hoàn dùng reservation.refund, sổ thật; phải liên kết hồ sơ. Không dùng termination.refund vì hệ thống hiện hành giả định nguồn đó thuộc thanh lý hợp đồng.
- Hoàn sau chỉ tạo hồ sơ nghĩa vụ; đến bước Hoàn tiền mới tạo phiếu chi. Không tạo phiếu khống trên sổ ảo để thay cho khoản phải trả khách.
- V1 trả toàn bộ phần còn phải hoàn một lần; không bổ sung lịch trả nhiều đợt.
- Hoàn ngay phải hoàn thành tạo/duyệt/ghi sổ trong một giao dịch server, tôn trọng quyền và chính sách duyệt hiện hành. Nếu không đủ quyền thực chi, cho người dùng chọn Hoàn sau; không âm thầm đổi lựa chọn.
- Hoàn tác phiếu chi qua cơ chế hiện hành làm nghĩa vụ mở lại; số đã trả chỉ tính từ posting còn hiệu lực. Lần chi lại không được làm tổng đã trả vượt nghĩa vụ.
- Phiếu nguồn và hai chân nghiệp vụ nội bộ được bảo vệ khỏi sửa tiền, đổi cọc, gắn hợp đồng, hủy, bỏ duyệt, xóa hoặc hoàn tác qua cửa thông thường sau khi đã xử lý.
- V1 chưa thêm thao tác hoàn tác toàn bộ quyết định bỏ cọc; sai sót phải có nghiệp vụ điều chỉnh được review riêng, không sửa dữ liệu trực tiếp.

## 5. Quyền, giao dịch và đồng thời

Dùng deposits.refund theo phạm vi tòa nhà cho xử lý cọc; việc ghi nhận doanh thu tự duyệt còn phải thỏa quyền income_expenses.approve và chính sách hiện hành. Hoàn tiền cần quyền thực chi/chiếm hữu sổ theo writer tài chính. Không cấp thêm quyền mặc định cho vai trò nào.

RPC kiểm lại quyền trên mọi lần gọi, kể cả replay idempotency; không trả hồ sơ của tổ chức khác. Bảng chỉ mở SELECT theo quyền tòa/tổ chức; ghi qua writer chuyên trách, có policy ẩn sandbox admin.

Preview trả fingerprint của căn cứ tiền. Commit đọc lại, khóa phòng → phiếu nguồn → hồ sơ/phiếu hoàn, kiểm fingerprint. Dùng cùng thứ tự khóa ở tạo hợp đồng, bỏ cọc, nhận giữ chỗ; chứng minh bằng test hai session. Một bên thắng thì bên kia nhận xung đột có nghĩa nghiệp vụ.

Hoàn ngay thất bại bất kỳ bước nào phải rollback cả xử lý cọc và tiền. Hoàn sau thành công thì việc nhận tiền hoàn sau là giao dịch độc lập.

Ngày ghi doanh thu và ngày hoàn tiền độc lập; chặn kỳ đã khóa, không tự chuyển sang kỳ khác.

## 6. Các cửa phải cập nhật cùng nhau

| Cửa | Nguồn hiện có cần đối chiếu khi triển khai |
|---|---|
| Danh sách cọc và cọc trong form hợp đồng | src/hooks/useDeposits.ts |
| Payload gắn phiếu vào hợp đồng | src/components/contracts/contract-form/useContractSubmit.ts |
| Gắn phiếu ở server | create_contract_v2, trg_contract_link_orphan_deposits, contract_deposit_links |
| Phòng giữ chỗ / trang sale công khai | room_has_holding_deposit, recompute_room_reservation |
| Khóa 24h và kỳ hạn | src/lib/reservationHold.ts, room_reservation_holds, reservation_hold_deadlines |
| Việc cần xử lý | src/lib/depositWorkQueue.ts |
| Thu chi desktop/mobile | IncomeExpenseDetailDialog.tsx, IncomeExpenseDetailMobile.tsx |
| Trang cọc desktop/mobile | DepositsPage.tsx, DepositsMobilePage.tsx |
| Thống kê cọc, hoàn tiền, doanh thu | useDepositDashboard.ts, get_reservation_deposit_summary, RPC tổng hợp và query tài chính |
| Realtime | src/hooks/realtime/finance.ts và các key phòng/phòng trống đang dùng |

Một predicate server thống nhất kiểm cọc còn khả dụng; danh sách và tổng hợp đều dựa vào đó. Không chỉ lọc trên màn hình rồi để RPC gắn lại cọc đã xử lý.

## 7. Phạm vi kiểm chứng và phát hành

Khảo sát đầu ở 1d6523fb; đối chiếu với origin/main cục bộ 4285b214 ngày 10/09. Đây là bằng chứng mã nguồn, chưa phải xác nhận object đang deploy. Trước triển khai lấy định nghĩa SQL live bằng đường chỉ đọc, đối chiếu manifest và writer hiện hành.

Phát hành đủ backend, UI và báo cáo trong một feature. Test bắt buộc: tiền thật, không đếm hai lần, hoàn sau, race với hợp đồng, hai lần chi đồng thời, quyền tòa/tổ chức, kỳ khóa, mixed items, receipt reversal và trạng thái phòng. E2E desktop/mobile trên DEMO; SQL harness chỉ TEST/DEMO. Không sửa dữ liệu org THẬT.

Luật vận hành và phát hành tham chiếu [PROJECT_CONTRACT](../../engineering/PROJECT_CONTRACT.md), không chép lại thành bộ quy định thứ hai. Kế hoạch chi tiết ở [kế hoạch triển khai](../plans/2026-09-10-reservation-deposit-settlement.md).
