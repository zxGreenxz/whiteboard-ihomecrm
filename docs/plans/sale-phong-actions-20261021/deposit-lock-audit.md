# Audit cọc, lock tạm và giữ chỗ — 21/10/2026

Phạm vi: snapshot `c095d427e`, phục vụ lập kế hoạch thao tác **cả Hermes và giao diện Sale Phòng**. Nhánh audit này đọc source, chạy kiểm thử offline và tạo bằng chứng; không sửa sản phẩm hay ghi database thật. Sau đó root bổ sung đối chiếu catalog chỉ đọc: bốn thân hàm liên quan khớp source, xem [biên bản tổng hợp](TEST-RESULTS.md).

## Kết luận

Đã có nền nghiệp vụ khá đầy đủ: lock 6/12/24 giờ; báo cọc có khách thật hoặc tên gợi nhớ; giữ chỗ theo đúng khách; bổ sung cọc; gắn khách; hủy giữ chỗ; quyết toán hoàn/giữ lại cọc; chuyển đúng nguồn cọc khi ký hợp đồng. Không nên tạo một hệ thống tiền/giữ chỗ riêng cho Hermes.

Trước khi mở rộng thao tác, cần xử lý các điểm nối chưa nhất quán: hai nguồn kỳ hạn không đồng bộ; hàng đợi tính phiếu chờ duyệt vào số đã thu; quyền sửa kỳ hạn ở RPC cũ; quyền hiển thị tạo cọc nhanh khác quyền máy chủ. Các phát hiện bên dưới phân biệt rõ source, proof offline và phần chưa đo bằng JWT/RLS thật.

## Bằng chứng kiểm thử mới

Lệnh đã chạy trên bản probe cuối:

```text
npx vitest run docs/plans/sale-phong-actions-20261021/deposit-lock-probe.test.ts --reporter=verbose --reporter=json --outputFile=docs/plans/sale-phong-actions-20261021/deposit-lock-probe-final-results.json
```

Kết quả: **4/4 phép tái hiện xác nhận được hiện tượng**. Đây là test mô tả lỗi đang có, không phải 4 tiêu chí nghiệm thu đã đạt.

- Fixture lấy từ `src/lib/__tests__/roomSaleLockMigration.test.ts`; chạy các migration workflow/sale-lock và thân RPC kỳ hạn hiện hành.
- Database là PGlite dùng một lần. Writer tiền, identity và authorization được stub như harness gốc; không tương đương toàn bộ PostgreSQL/JWT/RLS production.
- Hai lần đầu có lỗi ở chính probe (thiếu stub `is_admin`, assertion helper chưa đúng và alias SQL `day`); đã sửa fixture, giữ các report ban đầu, và chạy toàn bộ probe cuối thành công. Không sửa source để làm kiểm thử xanh.
- Runtime local Node `22.20.0`, Vitest `4.0.18`; đây không phải receipt CI/runtime phát hành được ghim.
- Kết quả suite có sẵn do root gom chạy được ghi trong báo cáo chính, tránh đếm trùng.

## Phát hiện cần xử lý

### D1 — Kỳ hạn tạo cọc nhanh không đi vào nguồn hàng đợi/Hermes; sửa hạn cũng không đồng bộ

**Mức đề nghị: P1 trước khi mở thao tác Hermes hàng loạt. Đã tái hiện offline.**

`src/pages/phong-trong/QuickDepositModal.tsx:42` gửi `holdUntil`, `topupDueOn` vào `create_room_reservation_v1`; RPC mới ghi `room_reservations` tại `supabase/migrations/20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.sql:543`, không ghi `reservation_hold_deadlines`.

Form đầy đủ tự thực hiện bước thứ hai: `src/components/deposits/CreateDepositDialog.tsx:324` gọi `setHoldTerms` cho phiếu nguồn. Mất kết nối ở bước này được báo là thành công một phần tại dòng 333. Form nhanh không có bước tương đương.

Hàng đợi đọc bảng kỳ hạn theo ID phiếu tại `src/lib/depositWorkQueue.ts:195`; hook đọc tại `src/hooks/useReservationHoldDeadlines.ts:50`. Reader Hermes hiện hành cũng nối chính bảng này tại `supabase/migrations/20261018182656_hermes_w2a_reservation_fund_member_v1.sql:57`.

Phép tái hiện:

1. Tạo reservation có hạn giữ `2026-10-01`, hạn bổ sung `2026-09-30`, mục tiêu 2.000.000 bằng RPC mới.
2. Response reservation chứa đủ các mốc; projection của phiếu nguồn sang bảng kỳ hạn trả cả ba trường `NULL`.
3. Tạo kỳ hạn phiếu `2026-10-01` rồi sửa hạn reservation thành `2026-10-05` qua `update_room_reservation_v1`.
4. Hạn reservation thành ngày 05, hạn phiếu vẫn ngày 01.

UI sửa hạn hiện tại chỉ gửi `UPDATE` vào reservation (`src/components/deposits/RoomReservationPanel.tsx:43`; SQL update tại `20260928025848_room_reservation_workflow.sql:222`). Tra toàn bộ migration không tìm thấy trigger đồng bộ hai nguồn. Root đã xác nhận ba body create/update/set-terms khớp catalog; chưa kiểm toàn bộ trigger/helper đang triển khai.

Hướng thực hiện: xác định kỳ hạn canonical của hồ sơ reservation; để hàng đợi/Hermes đọc cùng nghĩa, giữ adapter cho phiếu legacy chưa gắn hồ sơ. Việc tạo/sửa kỳ hạn hồ sơ mới phải nguyên tử với hồ sơ hoặc có trạng thái hoàn tất được đối soát; không tiếp tục hai nguồn độc lập.

### D2 — Phiếu bổ sung chưa duyệt làm biến mất cảnh báo thiếu cọc của phiếu đã duyệt

**Mức đề nghị: P1 đối với quyết định tiền và điều kiện ký. Đã tái hiện trực tiếp hàm TypeScript.**

`src/lib/depositWorkQueue.ts:187` cộng tất cả phiếu chưa quyết toán/chưa hủy theo phòng. Dòng 190 không loại `UNAPPROVED`; dòng 203 dùng tổng này làm `paid`, rồi dòng 204 tính thiếu.

Ca tái hiện: phiếu A đã duyệt 2.000.000, mục tiêu 5.000.000, hạn bổ sung đã qua. Ban đầu A thuộc `RESV_TOPUP_OVERDUE`. Thêm phiếu B 3.000.000 **chưa duyệt** cùng phòng: B vào `PENDING_APPROVAL`, nhưng A đổi thành `HOLD_READY` và cảnh báo thiếu biến mất.

`useReservationDeposits` không trả sự thật tiền đã nhận/posting (`src/hooks/useDeposits.ts:106`, `:156`); việc lọc chỉ `APPROVED` cũng chưa đủ để khẳng định đã nhận tiền nếu hệ thống tách duyệt và ghi quỹ. Reservation projection mới đã dùng `reservation_settlement_basis_v1(...)->received` (`20260928025848_room_reservation_workflow.sql:64`).

Hướng thực hiện: dùng received/posting truth chung của tiền, tổng theo reservation và nguồn cọc được liên kết; có quy tắc riêng cho dữ liệu legacy. Phiếu chờ duyệt/chưa nhận chỉ là khoản dự kiến. Kiểm lại việc cộng theo phòng với nguồn khác khách và cọc cũ chưa được gắn; không tự gộp chỉ vì cùng số phòng.

### D3 — RPC kỳ hạn cũ không kiểm quyền hành động sửa

**Mức đề nghị: P1 kiểm quyền trước khi bọc vào Hermes. Source + proof helper offline; chưa phải exploit/JWT production.**

Thân hiện hành `set_reservation_hold_terms_v1` tại `supabase/migrations/20260822120000_han_bo_sung_coc_cho_phieu_giu_cho.sql:122` kiểm `can_access_building OR ie_all_buildings_scope OR is_admin OR is_super_admin`, sau đó ghi tại dòng 156. Không có `deposits.edit`, `income_expenses.edit` hay `authorize_tenant_action_v3` trong thân này.

Probe đặt `can_access_building=true`, `is_admin=false`, `is_super_admin=false`; stub `authorize_tenant_action_v3('deposits.edit')` trả `false`. Gọi đúng thân RPC cũ vẫn đổi hạn thành công. Điều này chứng minh thiếu kiểm action trong hàm với môi trường helper đã mô tả. Không chứng minh tài khoản thật nào đang vượt RLS hay ma trận phân quyền của hệ thống đang triển khai.

Hướng thực hiện: chốt quyền đúng để sửa/xóa hạn, scope tổ chức/tòa và quyền trên phiếu; thực thi ở writer; thêm expected revision/idempotency cho sửa hạn legacy nếu còn dùng. Cần kiểm bằng JWT tài khoản chỉ xem, tài khoản mất quyền, tài khoản đa công ty trên TEST trước khi kết luận đã đóng.

### D4 — Nút tạo cọc nhanh và writer dùng hai quyền khác nhau, UI không xét từng tòa

**Mức đề nghị: P2. Kết luận từ source; chưa tái hiện vai thật.**

`src/pages/phong-trong/PhongTrongPage.tsx:69` mở tạo cọc nhanh bằng `sale_phong.create_deposit`. Writer mới yêu cầu `deposits.create` (`20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong.sql:513`); helper thực thi scope tòa và action tại `20260928025848_room_reservation_workflow.sql:45`.

`can()` chỉ hỏi có quyền ở bất kỳ tòa/sổ nào (`src/hooks/useMyPermissions.ts:113`), trong khi action đang nhắm một phòng cụ thể. Lock/gỡ cũng dùng các cờ chung tại `PhongTrongPage.tsx:72`. Máy chủ vẫn chặn sai quyền; không có bằng chứng vượt quyền. Người có quyền ở tòa A có thể được đưa nút cho tòa B rồi nhận từ chối.

Hướng thực hiện: thống nhất capability cho UI/Hermes theo phòng/tòa với writer, hoặc giữ quyền chuyên biệt Sale và quy định rõ cần giao của quyền nào. Nút tạo cọc không thể chỉ dựa vào quyền đã không còn được writer sử dụng.

## Trạng thái đang có và quy tắc phải giữ

| Đối tượng | Đường hiện có | Quy tắc quan trọng |
|---|---|---|
| Lock tạm | `lock_room_for_sale_v1`, `release_room_sale_lock_v1` | Chỉ 6/12/24 giờ; không khách/không tiền/không phiếu; tự hết hiệu lực theo thời gian máy chủ; chỉ `free/soon`, không PASS. |
| Giữ chỗ | `HOLD → CONVERTED/CANCELLED`; claim `LIVE → CONSUMED/CANCELLED` | Một claim đang sống cho mỗi phòng; có thể đặt trước phòng có thông báo trả hợp lệ; không đổi trạng thái ở thực tế. |
| Nhận cọc | `create_room_reservation_v1` + writer tiền hiện có | Tạo hồ sơ, nguồn cọc và gỡ lock cùng giao dịch. Tên gợi nhớ chỉ dùng khi có tiền; nguồn chờ duyệt vẫn giữ quyền khách nhưng chưa tính đã nhận. |
| Gắn khách | `assign_room_reservation_customer_v1` | Chỉ gắn khách thật cùng tổ chức vào hồ sơ tên gợi nhớ; CAS và lịch sử; giữ dấu vết tên ban đầu. |
| Bổ sung/sửa/hủy | `update_room_reservation_v1` | Revision chống ghi đè; idempotency; không hủy hồ sơ còn nguồn tiền chưa xử lý. |
| Quyết toán cọc | `settle_reservation_deposit_v1` + refund workflow | Hoàn toàn bộ/một phần/không hoàn; căn cứ tiền và fingerprint; hoàn chờ trả không đồng nghĩa tiền đã ra; chứng từ riêng. |
| Ký hợp đồng | Guard claim + consume claim | Khách thật, đúng reservation/revision, đúng toàn bộ nguồn cọc đã nhận; nguồn chưa duyệt/chưa nhận chặn ký; hợp đồng mới và nhận nguồn cùng giao dịch. |
| Quá hạn | Reservation overdue là nhắc xử lý | Hết hạn giữ có cọc không tự nhả phòng, tự hoàn hay tịch thu. Chỉ lock không tiền tự hết giờ. |

Chứng cứ: sale-lock SQL dòng 365–388/395–417/548–552; signing guard dòng 558–581; reservation workflow dòng 192–233/249–299. Tests PGlite hiện có kiểm replay, claim, sai khách/nguồn, pending, scope, tính nguyên tử khi writer lỗi. Chưa chứng minh race thật với nhiều connection.

Lưu ý sản phẩm: UI đã bỏ giữ chỗ 0 đồng; API reservation vẫn hỗ trợ khách thật + hạn, được test riêng (`roomReservationMigration.test.ts:68`). Hermes mới cần tuân theo sản phẩm hiện hành: giữ không tiền đi qua lock tạm, không tự chọn nhánh 0 đồng chỉ vì API vẫn tồn tại.

## Danh mục tình huống chủ trọ cần được đáp ứng

Các mục chưa có hành vi rõ phải được chốt thành quyết định sản phẩm; không tự suy diễn thành quyền xử lý tiền.

| Nhóm | Tình huống / kết quả phải thống nhất ở UI và Hermes |
|---|---|
| Xác định phòng | Tên phòng trùng ở nhiều tòa; nhiều công ty; phòng đổi tên; yêu cầu chỉ nói “phòng vừa xem”; mã/phòng đã xóa. Resolve chính xác ID và scope, hỏi lại khi nhiều đích. |
| Kiểm tình trạng | Trống sẵn, sắp trống có ngày trả, báo trả quá hạn, đang chuẩn bị sửa/dọn, PASS, có người ở, có hợp đồng tương lai, có claim/cọc legacy. Trả đúng lý do được/chưa được thao tác. |
| Lock | Chọn 6/12/24 giờ; ghi chú; xem người lock và hết hạn; lock trùng; hai sale lock đồng thời; mạng mất sau khi lưu; bấm lại; đổi ghi chú khi đang lock; gia hạn có chủ đích. |
| Gỡ lock | Chính người lock còn quyền; quản lý được tạo cọc; người khác không quyền; quyền vừa bị thu hồi; lock đã hết; lock đã đổi thành cọc; phòng vừa có hợp đồng. Chỉ gỡ lock đích, không mở lại phòng đã có cọc/ở. |
| Hết giờ | Tính theo máy chủ khi máy người dùng lệch giờ, tab background/mất mạng, hết giờ đúng biên, sale khác vừa lock mới. Trình bày dữ liệu đã cũ; không dùng đồng hồ UI để quyết định writer. |
| Báo cọc | Khách danh bạ hoặc tên gợi nhớ; sổ nhận tiền; số nguyên VND dương; ngày phiếu; ảnh chứng từ; tiền mặt/chuyển khoản; đã thu hay mới báo; thiếu chứng từ; phí khác đi kèm. |
| Cọc trước ngày trống | Phòng vẫn có khách nhưng có báo trả; ngày vào trước/ngang/sau ngày báo trả; báo trả thay đổi sau khi nhận cọc; khách cũ trì hoãn; phòng cần dọn/sửa. Không cam kết sẵn phòng chỉ từ ngày dự kiến. |
| Điều khoản | Cọc mục tiêu, hạn bổ sung, hạn giữ, ngày vào, giá đã hứa, người giới thiệu/sale, chính sách áp dụng lúc nhận, điều kiện hoàn/không hoàn. Lưu bản thỏa thuận tại thời điểm chốt. |
| Nhận bổ sung | Nhiều lần và nhiều nguồn; cọc dư/thiếu; phiếu pending, approved nhưng chưa ghi quỹ, bị trả lại, bị hủy, bị đảo posting. Tổng đúng tiền đã nhận cho đúng khách/hồ sơ. |
| Sai thông tin | Sửa tên gợi nhớ; gắn khách trùng số điện thoại; chọn nhầm khách/tòa/phòng/sổ/tiền; hai người sửa cùng lúc. Không sửa trực tiếp lịch sử nguồn tiền; sửa bằng luồng được phép có dấu vết. |
| Thay đổi giao dịch | Đổi phòng cùng tòa, khác tòa, chuyển cọc sang phòng khác, chia/gộp nguồn cọc; người cọc thay người ký; đổi tổ chức. Hiện chưa thấy một writer reservation chuyển phòng; cần thiết kế riêng, không ghép hủy+tạo tùy tiện. |
| Hết hạn cọc | Gia hạn, chờ khách phản hồi, no-show, đổi ý, chủ không giao được phòng; nhắc bổ sung hoặc nhắc ký; giữ nguyên tiền/quyền khách cho đến quyết định có căn cứ. |
| Hủy cọc | Chưa duyệt/chưa thu → hủy nguồn; đã thu → chọn hoàn/giữ lại một phần/toàn bộ và lý do; còn nhiều nguồn; một nguồn đang chờ. Không cho một nút “hủy” lẫn hủy hồ sơ với xóa tiền. |
| Hoàn | Hoàn ngay hoặc ghi nghĩa vụ chờ; sổ chi, ngân hàng/tên người nhận; sai tài khoản, từ chối/duyệt lại, trả tiền thành công nhưng mất response, chứng từ thiếu/trùng; không trả trùng nghĩa vụ. |
| Giữ lại cọc | Theo thỏa thuận và người có quyền, số tiền không vượt đã nhận, lý do và lịch sử, khoản phải hoàn còn lại, hủy thưởng sale/hoa hồng liên quan. Không tự tịch thu chỉ vì qua ngày. |
| Ký | Chưa gắn khách thật; đúng khách/nguồn/revision; tiền chưa nhận; giá/ưu đãi thay đổi; cọc đủ hoặc ghi nhận thiếu theo điều khoản hợp đồng; tranh chấp với người ký khác; recover response sau commit. |
| Sau quyết toán | Hồ sơ còn LIVE hay đã hủy; tiền hoàn vẫn pending nhưng phòng được bán lại theo quyết định nào; listing và lượng phòng trống; thông báo người lock/sale chịu trách nhiệm; không lẫn nghĩa vụ tiền với khả dụng phòng. |
| Quản trị | Scope từng tòa/từng quỹ, người chỉ xem, sale chỉ lock, quản lý tạo cọc, người duyệt/chi, chủ nhiều công ty; khóa tài khoản/thu hồi quyền giữa preview và commit. |
| Khôi phục | Timeout trước/sau commit; gửi lại cùng key; đổi payload cùng key; đóng/mở lại form; hai tab; offline; không thể ghi local pending store; action bị hủy trong lúc đang gửi. |
| Lịch sử/báo cáo | Ai yêu cầu/ai duyệt/ai làm, kênh UI/Hermes, trước/sau, lý do, tiền thực nhận/hoàn/giữ lại, số phòng đang lock/giữ/cho thuê, cảnh báo hết hạn và nguồn evidence. |

## Kế hoạch thực hiện riêng cho cọc/lock

1. **Chốt hợp đồng dữ liệu và action**: phân biệt lock, reservation, tiền và trạng thái phòng; lập capability theo tòa; xác định nguồn kỳ hạn; xác định phòng PASS có nhận cọc hay chỉ giới thiệu. Đóng D1–D4 bằng regression test hành vi đúng.
2. **Củng cố writer dùng chung**: giữ các RPC hiện có; bổ sung một forward migration cho phần thực sự cần, không sửa migration lịch sử. Durable idempotency cho lock hiện đang chỉ replay cùng người/nội dung trong 2 phút (`...lock_tam_phong.sql:376`); revision cho điều khoản/kỳ hạn; kiểm scope/action trước đọc kết quả cũ; receipt rõ ID/trạng thái tiền.
3. **Hoàn thiện UI**: nút theo capability của từng phòng; form nhanh và form đầy đủ dùng cùng intent/service; pending receipt tồn tại qua đóng/mở lại; màn hồ sơ cho đổi hạn/ngày vào/mục tiêu/ghi chú, topup, gắn khách, giải quyết nguồn cọc và hủy. Form hiện tại chỉ cho sửa hạn dù API có nhiều trường; xử lý lỗi stale/denied/unknown/partial tách biệt.
4. **Bọc thao tác Hermes**: resolve scope từ người gọi và connection; preview chứa đúng phòng/tòa/tiền/sổ/khách/hạn/tác dụng listing; commit gọi cùng writer; không cho model gửi SQL hoặc tự chọn quỹ/người nhận. Giữ request key và expected revision từ preview; reauthorize ở commit; trả receipt và các bước chưa xong. Giai đoạn đầu lock/gỡ trước, tạo cọc/gắn khách/topup sau; hoàn/giữ lại cọc và ký cần chứng minh tiền/quyền đầy đủ.
5. **Kiểm tích hợp**: baseline + forward disposable PostgreSQL; nhiều connection cho lock vs lock, lock vs create, create vs create, topup vs sign, settle vs sign, cancel vs topup; JWT role matrix gồm org/tòa/quỹ; mutation kiểm guard/ràng buộc/idempotency không xanh rỗng. UI/E2E theo viewport/vai trò thực sự ảnh hưởng và Hermes replay cùng intent.
6. **Tích hợp với phần Claude đọc**: giữ chữ ký/payload reader đã chốt; công bố schema action và fixtures riêng. Bất kỳ đổi nguồn kỳ hạn/received truth nào phải cập nhật adapter reader và parity tests cùng một gói tích hợp, tránh để UI/Hermes đọc hai nghĩa. Hai bên có thể làm nhánh/worktree riêng; chỉ merge sau khi contract/fixtures chung thống nhất.
7. **Phát hành**: tiền/quyền/migration qua draft PR, review đúng diff cuối; receipt focused tests được tái dùng; gate theo Contract; dữ liệu thử chỉ TEST/DEMO được phép; không nhận kết quả PGlite là kiểm production. Mở action theo nhóm để đo lỗi/conflict/unknown outcome, có tắt action riêng không làm mất bộ đọc.

## Phần chưa xác minh

- Root đã đối chiếu body bốn hàm cụ thể, chưa chứng minh toàn bộ schema/helper/trigger đang chạy đúng snapshot.
- Chưa chạy JWT/RLS thật hoặc đối chiếu grant hiện hành của RPC kỳ hạn trên TEST/production.
- Chưa chạy race hai connection PostgreSQL, rollback do deadlock hay cạnh tranh queue thực.
- Chưa kiểm UI/E2E trên tài khoản/vai trò thật trong nhánh audit này; parent có thể bổ sung bằng chứng browser riêng.
- Probe dùng stub money writer, không kiểm cân sổ/posting v1/v2, chứng từ R2, hoàn tiền thực, ngân hàng hay thông báo.
- Chưa sửa lỗi; chưa deploy, push hoặc thay dữ liệu. Các ca nghiệp vụ trên là phạm vi nghiệm thu đề xuất, không phải lời khẳng định mọi ca đã có test.
