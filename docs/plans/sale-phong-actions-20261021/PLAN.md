# Sale Phòng: kiểm tra hiện trạng và kế hoạch hiện thực cho web + Hermes

Ngày lập: 21/10/2026. Snapshot kiểm: `c095d427eda5078c422c3c529ae1f1329807bb63` từ `origin/main`.

**Mục tiêu:** Sale Admin và quản lý cập nhật phòng nhanh, sale nhìn thấy thông tin đúng và mới; cùng thao tác được trên web, điện thoại và Hermes. Bao gồm phòng trống/sắp trống, lock, cọc, pass, ảnh, thông tin, chính sách và chia sẻ cho sale.

**Trạng thái tài liệu:** đã kiểm source, chạy các bộ kiểm liên quan, tái hiện lỗi bằng dữ liệu giả, xem web thật chỉ đọc và đối chiếu bốn thân hàm database bằng truy vấn chỉ đọc. Chưa sửa sản phẩm, chưa phát hành. Các mục “đề xuất”, “nghiệm thu” phía dưới là việc cần làm, không phải tính năng đã hoàn thành.

## 1. Kết luận và hướng sản phẩm

Nền hiện tại đã có phần lớn nghiệp vụ web: trang phòng trống, thông tin/ảnh, pass, lock, cọc, link chia sẻ và lịch gửi. Hermes đã có đọc dữ liệu, thao tác pass và điều khiển lịch gửi; chưa có đầy đủ thao tác lock, cọc, ảnh, thông tin và chương trình.

Đề xuất dùng **một bảng cập nhật phòng chung**, đặt tại luồng Sale Phòng hiện có. Mỗi dòng có hành động nhanh; bấm phòng mở bảng chi tiết bên cạnh; điện thoại mở bảng hành động từ dưới lên. Hermes ghi qua cùng nghiệp vụ phía máy chủ. Không cần xây một bộ quản lý phòng hoặc sổ cọc thứ hai.

Các việc nền phải làm trước khi mở rộng ghi: kiểm quyền listing pass nguồn; thống nhất kỳ hạn giữ cọc; dùng tiền thực nhận để tính thiếu cọc; sửa quyền RPC kỳ hạn; thống nhất quyền nút bấm với writer. Số test xanh hiện tại không bao phủ hết các lỗi này.

Tài liệu chi tiết:

- [Thiết kế cập nhật nhanh cho Sale Admin/quản lý](QUICK-UPDATE.md).
- [Kết quả kiểm và phần chưa xác minh](TEST-RESULTS.md).
- [56 kịch bản web W01–W56, hiện trạng và bằng chứng W1–W7](web-audit.md).
- [Cọc/lock: trạng thái, 20 nhóm tình huống và bằng chứng D1–D4](deposit-lock-audit.md).
- [Hermes: công cụ hiện có, hợp đồng đề xuất và các ca xuyên kênh](hermes-audit.md).
- [Kịch bản bổ sung có mã để giao việc và nghiệm thu](OWNER-SCENARIOS.md).

## 2. Kết quả kiểm chính

| Hạng mục | Kết quả | Giới hạn |
|---|---|---|
| Web, nghiệp vụ, worker | 62 tệp, 798 ca; lần gom chạy: 797 đạt, 1 lỗi | Tệp có lỗi chạy riêng lại đạt 21/21; chưa kết luận nguyên nhân lỗi lần đầu |
| Hermes | 26 tệp, 356/356 đạt | Gồm contract/SQL fixture/composition; không thay thế gửi Zalo thật |
| Probe mới | 7 ca, gồm tái hiện và đối chứng | Xác nhận lỗi đang tồn tại; không phải các lỗi đã sửa |
| TypeScript | Khớp baseline, 0 fingerprint | Không chứng nhận hành vi nghiệp vụ |
| Đối chiếu Hermes–web | Đạt: 72 mục, 89 vùng web, 35 nguồn SQL | Kiểm cấu trúc, không chứng minh mọi thao tác đã có |
| Catalog database | Bốn thân hàm khớp source | Chưa chứng minh toàn bộ quyền/helper/trigger/JWT/PostgREST |
| Web thật | Mở sáu tab quản trị và link public; mở rồi hủy form pass | Chỉ đọc; chưa chạy luồng ghi E2E; xuất ảnh chưa thu được tệp xác nhận |

Không cộng 21 ca chạy lại vào 1.154 ca sẵn có để làm tăng coverage. Môi trường kiểm chính dùng Node 24.19.0; một số probe dùng Node 22.20.0, khác runtime CI được ghim. Chi tiết và log nằm trong [TEST-RESULTS.md](TEST-RESULTS.md).

## 3. Danh sách ưu tiên sửa

| Mã | Ưu tiên | Vấn đề và tác động | Mức bằng chứng |
|---|---|---|---|
| W1 | P1 | RPC sửa pass kiểm phòng đích nhưng chưa kiểm listing nguồn; có thể sửa listing ngoài tòa được giao bằng ID nguồn khác | Tái hiện PGlite với đối chứng; body deployed khớp; chưa thử JWT thật |
| D1 | P1 | Reservation và phiếu giữ chỗ có hai nguồn kỳ hạn; tạo nhanh/sửa hạn không đồng bộ sang hàng đợi/Hermes | Hai probe tái hiện; body ba RPC liên quan khớp catalog |
| D2 | P1 | Phiếu bổ sung chưa duyệt làm mất cảnh báo thiếu cọc ở hàng đợi | Chạy hàm mã sản phẩm cục bộ với dữ liệu giả; chưa có bằng chứng vượt guard ký hợp đồng |
| D3 | P1 | RPC kỳ hạn cũ kiểm phạm vi truy cập nhưng thiếu kiểm quyền hành động sửa | Thân hàm + probe helper; body deployed khớp; chưa chứng minh vai thật vượt quyền |
| D4 | P2 | Nút cọc nhanh kiểm quyền khác writer, cờ chung chưa xét đúng tòa | Source; cần ma trận vai thật |
| H5 | P2 | Chính sách pass có ở dữ liệu bảng ảnh nhưng rơi khỏi tin chi tiết khi `saleNote` rỗng | Hai ca dùng hàm export từ mã sản phẩm cục bộ; chưa gửi provider/render PNG |
| H4 | P2 | Tin đã xếp hàng có thể giữ nội dung phòng cũ sau khi lock/cọc/giá thay đổi | Source; cần test chạy hàng đợi theo thời gian |
| W4/W5 | P2 | Bản nháp có thể bị refetch thay thế; thiếu kiểm phiên bản khi sửa ảnh, nhiều phòng và sơ đồ | Source; chưa tái hiện từng ca UI |
| W2/W3 | P2 | Mô tả “sắp trống” khác sự thật nghiệp vụ; công tắc hiện phòng đã thuê chưa có tác dụng như người dùng có thể kỳ vọng | Source; đã thấy mô tả trên UI |
| W6/W7 | Thiết kế | Scope token/settings của owner chưa đồng nhất với ủy quyền; liên hệ khách pass chưa có sự đồng ý công khai lưu thành dữ liệu | Khoảng trống cần quyết định và nghiệm thu |

P1 ở đây là thứ tự ưu tiên đề xuất trong dự án, không phải kết luận đã có sự cố khai thác hay mất tiền thực tế.

## 4. Quy tắc nền phải giữ

1. **Tách việc chào phòng và việc ở thực tế.** Đăng/ẩn/pass/lock không tự kết thúc hợp đồng. “Hết hạn hợp đồng” không tự biến thành “sắp trống”; cần báo trả hợp lệ.
2. **Tách lock không tiền và hồ sơ có cọc.** Lock hiện tại 6/12/24 giờ, chỉ phòng `free/soon`, tự hết hiệu lực theo giờ máy chủ. PASS hiện không lock được. Giữ nguyên giới hạn này ở đợt đầu.
3. **Báo cọc khác đã nhận tiền.** Phiếu chưa duyệt hoặc chưa ghi nhận nhận tiền không làm tăng tiền thực thu. Dùng `received/posting` đúng nguồn, đúng khách/hồ sơ.
4. **Quá hạn cọc chỉ là cảnh báo.** Không tự nhả phòng, hoàn tiền, giữ lại tiền hay hủy claim khi hết hạn.
5. **Một quyền đặt phòng còn hiệu lực cho một phòng.** Cọc hợp lệ gỡ lock trong cùng giao dịch, kể cả lock của sale khác theo quyền writer hiện hành; phải hiện hậu quả này cho người thao tác.
6. **Nguồn tiền không ghép theo số phòng đơn thuần.** Bổ sung/chuyển nguồn/ký dùng ID nguồn được liên kết; không lấy cọc khách cũ chỉ vì cùng phòng.
7. **Giá quảng cáo khác giá hợp đồng.** Cập nhật giá/chương trình không âm thầm sửa hợp đồng đã ký hoặc tạo bút toán.
8. **Công khai có danh sách trường cho phép.** Hoa hồng sale, ghi chú nội bộ, chứng từ cọc và thông tin khách không được tự xuất ra link/ảnh/tin.
9. **Sửa có phiên bản, gửi lại có mã yêu cầu.** Hai người sửa cùng phòng phải thấy xung đột; mất phản hồi phải tra kết quả cũ trước khi thử lại.
10. **Cùng một kết quả cho mọi kênh.** Web máy tính, điện thoại, public, Hermes và worker dùng chung fact và cách chọn chính sách. Kênh nào có trễ phải hiện lần cập nhật thành công gần nhất.

API vẫn còn hỗ trợ giữ chỗ 0 đồng nhưng UI đã bỏ. Đợt đầu Hermes dùng lock cho yêu cầu giữ không tiền, không tự mở lại luồng cũ.

## 5. Thiết kế dữ liệu và phân quyền

### 5.1 Dữ liệu dùng lại và phần bổ sung

| Nhóm | Nguồn hiện có cần dùng lại | Bổ sung đề xuất |
|---|---|---|
| Trạng thái phòng | Hợp đồng/báo trả + `roomSaleFacts` + projection chuẩn | Hiển thị lý do, ngày dự kiến, lần xác minh; tách thông tin chủ báo chưa xác minh |
| Lock | `lock_room_for_sale_v1`, `release_room_sale_lock_v1`, reader lock | Mã yêu cầu bền vững, receipt tra lại, kiểm phiên bản/thời điểm khi cần |
| Cọc/giữ chỗ | `room_reservations`, claim, voucher/settlement chuẩn | Một nguồn điều khoản canonical; adapter legacy; snapshot thỏa thuận khi chốt |
| Pass | `room_pass_listings`, writer hiện có | Quyền nguồn + đích, revision, liên kết kỳ hợp đồng, lý do đóng/ẩn, sự đồng ý công khai |
| Thông tin/ảnh | Room/building, storage và metadata hiện có | Patch theo trường, revision, bản nháp, trạng thái upload/attach riêng |
| Chính sách | `sale_note`, `sale_bonus_note`, `pass_sale_policy`, settings | Bước đầu thống nhất render; bước sau chương trình có scope/hiệu lực/version |
| Chia sẻ | Token/settings và public RPC hiện có | Hợp đồng đại diện owner; TTL/scope/kênh nếu đưa vào phạm vi phát hành |
| Lịch sử thao tác | Receipts/audit hiện có theo module | Envelope dùng chung để đọc trạng thái yêu cầu UI/Hermes |

Không tạo bảng mới nếu đã có đối tượng phù hợp. Tên/DDL cụ thể phải được xác định khi triển khai qua source và migration forward; bảng này không chỉ thị tạo song song một schema.

### 5.2 Ma trận vai trò đề xuất

Phân quyền thực hiện theo **hành động + tòa + quỹ + tổ chức**, không dựa duy nhất vào tên chức danh.

| Thao tác | Sale thông thường | Sale Admin | Quản lý/chủ |
|---|---|---|---|
| Xem thông tin đang chào | Trong tòa được giao | Trong phạm vi vận hành | Trong phạm vi quản lý |
| Đề nghị đổi ngày/ảnh/thông tin | Gửi đề nghị nếu chưa có quyền ghi | Ghi trực tiếp nếu được giao | Ghi và xử lý ngoại lệ |
| Sửa thông tin công khai/ảnh | Cấp riêng khi cần | Quyền ghi theo tòa/trường | Quyền ghi theo tòa |
| Lock/gỡ lock | Theo quyền lock và quy tắc gỡ | Theo quyền được cấp | Theo quyền được cấp, có lý do khi can thiệp |
| Báo cọc/bổ sung | Chỉ khi có `deposits.create` và quỹ phù hợp | Như writer hiện hành | Như writer hiện hành |
| Duyệt/nhận/hoàn/giữ lại tiền | Không suy từ quyền sale | Cấp riêng theo luồng tiền | Cấp riêng theo luồng tiền |
| Công bố chương trình/đổi giá hàng loạt | Đề nghị | Có thể chuẩn bị/preview | Người có quyền công bố |
| Tạo/thu hồi link | Quyền riêng và scope rõ | Quyền riêng và scope rõ | Quyền riêng và scope rõ |

Đây là ma trận khởi đầu để cấu hình, chưa tự thay quyền đang cấp. Nút trên UI và resolver Hermes phải hỏi cùng capability của phòng, máy chủ kiểm lại lúc ghi.

### 5.3 Contract thao tác chung

- Đầu vào: ID đích đã xác định, action, patch trường được phép, `expectedRevision` khi sửa, `requestId`, dữ liệu xác nhận công khai theo cơ chế hiện có.
- Actor/org/connection lấy từ danh tính phía máy chủ; không cho model tự gửi để mở scope.
- Kết quả: `applied/rejected/conflict/outcome_unknown/partial`, ID thật, revision mới, thời gian máy chủ, tác động đến chào phòng, các phần đã xong/chưa xong.
- Cùng mã + cùng payload trả kết quả cũ; cùng mã + payload khác bị từ chối. Status/reconcile không tạo thêm side effect.
- Đối tượng ngoài quyền không lộ dữ liệu qua kết quả replay hay thông báo xung đột.
- Ghi nhiều phòng có kết quả riêng từng phòng; chỉ thử lại phần đã xác định chưa áp dụng và còn hợp lệ. Unknown phải đối soát; denied/conflict/mục tiêu đã xóa phải xử lý nguyên nhân trước. Tiền/claim trong một hồ sơ phải atomic theo writer chuẩn.

## 6. Các gói hiện thực theo thứ tự

### G0 — Chốt giao diện đọc/ghi và bộ tình huống

**Việc làm:** lập DTO dùng chung; chuẩn hóa tên trạng thái hiển thị và nguồn fact; chốt capability theo phòng; chốt cách đọc kỳ hạn/tiền legacy; ghi danh mục trường public/internal. Dùng W01–W56, M01–M26, X01–X20 và Q01–Q12 làm backlog nghiệm thu.

**Vùng mã:** `src/lib/roomSaleFacts.ts`, `src/lib/reservationIdentityRpc.ts`, `src/lib/roomSaleLockRpc.ts`, `infra/hermes-broker/*-contract.mjs`, public/room projection đang dùng.

**Xong khi:** mỗi nút/tool chỉ tên được writer, quyền, nguồn trạng thái, receipt và test; những hành vi chưa có writer không mở cho người dùng.

### G1 — Đóng lỗi quyền và sự thật tiền/kỳ hạn

**Việc làm:** sửa W1, D1–D4. Pass sửa phải khóa/kiểm listing nguồn; ưu tiên không cho đổi room trong một lệnh sửa thông thường. Kỳ hạn hồ sơ đọc từ nguồn chuẩn; legacy có adapter và báo trường hợp lệch. Hàng đợi dùng tiền đã nhận theo đúng nguồn. RPC kỳ hạn kiểm action đúng; UI lấy capability cùng writer.

**Vùng mã:** migration forward mới dựa trên các hàm ở `20260629100000`, `20260822120000`, `20260928025848`, `20261010114500`; `src/lib/depositWorkQueue.ts`; hooks kỳ hạn/cọc; `QuickDepositModal`, `CreateDepositDialog`, `RoomReservationPanel`; reader cọc Hermes.

**Xong khi:** probe hiện tại được chuyển thành regression kỳ vọng đúng; sai listing/sai org/sai tòa/không action bị chặn; pending không xóa cảnh báo; tạo/sửa hạn thấy giống nhau ở UI và Hermes; legacy không bị tự gán sai khách. Kiểm JWT và race thật thuộc G8, không chỉ dựa PGlite.

### G2 — Writer, receipt và chống ghi đè dùng chung

**Việc làm:** hoàn thiện mã yêu cầu bền vững cho lock; thêm revision cho pass/settings/ảnh/thông tin theo đối tượng cần thiết; tách service ghi khỏi component; hợp nhất phản hồi unknown/partial. Giữ thứ tự khóa phòng → tổ chức của writer hiện hành. Không sửa lịch sử migration.

**Vùng mã:** hooks/`src/lib/*Rpc*`, writer SQL forward, broker action service/adapter mới, pending receipt store hiện có.

**Xong khi:** UI và Hermes gửi cùng intent cho cùng kết quả; timeout trước/sau commit không tạo lock/cọc/link trùng; đổi payload cùng key bị chặn; reauthorization trước ghi/replay; conflict không ghi đè người khác.

### G3 — Bảng cập nhật nhanh và điện thoại

**Việc làm:** bảng chung, tìm phòng bằng tên tòa/mã phòng, bộ lọc cần cập nhật, hành động trên dòng, bảng chi tiết, phím tắt hợp lý; hiển thị nguồn và thời điểm cập nhật. Nguồn bảng quản trị là inventory phòng trong scope kết hợp sale fact, không chỉ danh sách phòng đang chào; phải tìm được phòng đang ở/ẩn/nháp hoặc vừa cọc. Giữ kết quả thao tác khi dòng rời bộ lọc sau lưu. Lưu từng trường cần sửa, giữ bản nháp khi refetch/đổi phòng/mất mạng. Các hành động tiền mở form hiện có đã chuẩn hóa.

**Vùng mã:** `src/pages/sale-phong/SalePhongPage.tsx`, `SalePhongMobilePage.tsx`, components sale-phong, `src/pages/phong-trong/*`, hooks query/invalidation.

**Xong khi:** đạt phần web của Q01–Q03, Q08–Q09 trong [QUICK-UPDATE.md](QUICK-UPDATE.md). Q04/Q07 hoàn tất cùng G4; Q05/Q06/Q12 cùng G5; Q10 cùng G7; Q11 là hàng đợi đề nghị ở đợt D. Đủ Q01–Q12 là điều kiện nghiệm thu toàn phạm vi cuối. Mục tiêu UX cho việc đơn giản là 1–3 lần chạm sau khi tìm được phòng; đây là mục tiêu cần đo, không phải số đã đo. Cọc/hoàn tiền không bị rút gọn mất dữ liệu bắt buộc.

### G4 — Ảnh, thông tin và thao tác hàng loạt

**Việc làm:** upload → kiểm file → gắn ảnh → đọc lại; ảnh bìa/thứ tự; thay/ghép bộ ảnh; draft bền; preview mục tiêu hàng loạt và kết quả riêng. Patch theo trường/tầng cho sơ đồ hoặc CAS toàn snapshot có giải quyết xung đột. Bản cập nhật từ tin nhắn/ảnh cần ghép đúng phòng trước commit.

**Vùng mã:** `SaleImagesTab.tsx`, `MobileSaleInfo.tsx`, `useSaveRoomListSheet.ts`, `FloorPlanEditorTab.tsx`, storage/media service hiện có.

**Xong khi:** không mất bản nháp khi refetch; 8 ảnh lỗi 2 chỉ retry 2; phòng ngoài quyền không đổi; không xóa blob đang dùng chung; hai người sửa hai tầng không làm mất nhau; không gán ảnh nhầm phòng khi tên trùng.

### G5 — Hermes thực hiện thao tác

**Việc làm:** thêm resolver theo action; tool lock/gỡ/status; cọc/tăng cọc/gắn khách/sửa điều khoản/hủy hồ sơ đủ điều kiện/status; hoàn thiện pass OCC; tool thông tin/ảnh/settings/link sau khi writer sẵn sàng. Dùng schema strict và receipt chung, giữ cơ chế preview chữ công khai đang có. Thiếu đích/tiền/quỹ thì hỏi đúng phần thiếu; lệnh rõ không hỏi lại toàn bộ.

**Ranh giới đợt đầu:** quyết toán/hoàn/giữ lại cọc/ký hợp đồng tiếp tục dùng workflow web hiện có; Hermes đọc trạng thái và dẫn đúng hồ sơ, chưa tự ghi các hành động này. Chỉ mở tool tương ứng ở lát cắt sau khi đã có contract riêng và bằng chứng G8 về tiền/quyền/replay. Không dùng “hủy hồ sơ” để thay quyết toán.

**Vùng mã:** các module mới `infra/hermes-broker/sale-*-contract/adapter/service` theo kiến trúc hiện có; `broker.mjs`, `server.mjs`, registry và test argument/capability do integrator ghép.

**Xong khi:** mọi action có ca đúng, sai quyền, sai đích, stale revision, retry và lost ACK; trả câu dễ hiểu có đúng phòng/đã làm/đang chờ. “Đã tạo phiếu chờ duyệt” không biến thành “đã nhận tiền”; “đã xếp lịch” không biến thành “đã gửi”.

### G6 — Chính sách, chương trình và công bố

**Bước đầu:** sửa H5; thống nhất thứ tự ưu tiên của chữ chính sách hiện tại giữa web, bảng ảnh, tin chi tiết và Hermes. Tách thưởng sale nội bộ khỏi ưu đãi khách. Cho sửa/copy theo phạm vi có preview và audit.

**Bước mở rộng:** chương trình có tên, phạm vi, đối tượng hưởng, mốc hiệu lực theo timezone, điều kiện, mức ưu đãi, ưu tiên/cộng dồn, trạng thái nháp/công bố/hết hạn, version. Lưu snapshot vào thỏa thuận cọc khi chốt. Không tự suy điều kiện tài chính từ đoạn văn tự do.

**Vùng mã:** settings/room/pass DTO, `worker/lib/automation.js`, `room-list-table.js`, public renderer; migration/program service mới chỉ khi triển khai chương trình có cấu trúc.

**Xong khi:** cùng fixture cho kết quả giống nhau ở tất cả kênh; chính sách hết hạn không áp cho khách mới; khách đã chốt giữ thỏa thuận đã duyệt; không lộ thưởng sale hoặc tự đổi giá hợp đồng.

### G7 — Đồng bộ cho sale, link và lịch gửi

**Việc làm:** invalidation đúng phạm vi sau ghi; realtime nếu hạ tầng sẵn có đáp ứng, polling dự phòng với lần cập nhật cuối. Tin chờ gửi lưu version nguồn, kiểm lại tình trạng/giá/chính sách trước provider; hủy hoặc dựng lại phần chưa gửi khi stale. Token/settings phải chốt cơ chế owner/đại diện trước khi mở cho nhân viên.

**Vùng mã:** query hooks public/admin, public RPC/token, automation queue/worker, delivery/finalization.

**Xong khi:** tab sale đang mở cập nhật đúng sau lock/cọc/ảnh; kết nối lỗi hiện thông tin cũ; queued/sent/partial/unknown phân biệt. `sent` cần mã provider và finalize; chỉ thêm `delivered` khi có biên nhận giao tới người nhận được kiểm chứng. Không hứa cập nhật được ảnh/tin đã gửi ra ngoài. Dùng một scheduler CRM hiện có.

### G8 — Nghiệm thu môi trường TEST và đưa vào dùng theo nhóm

**Việc làm:** chạy baseline + migration forward trên PostgreSQL dùng thử; nhiều connection; JWT/PostgREST theo vai/tòa/quỹ/org; mutation của các guard quan trọng; UI máy tính/điện thoại; Hermes với cùng intent; worker/provider trên nhóm thử được phép. Kiểm legacy có hồ sơ thiếu liên kết hoặc kỳ hạn lệch trước chuyển đổi.

**Xong khi:** đóng checklist bên dưới, có bằng chứng đầu vào cuối và người review đúng Contract. Chỉ mở từng nhóm action đã đạt. Cho phép tắt từng tool/tính năng mới trong khi bộ đọc vẫn hoạt động.

Thứ tự phụ thuộc: `G0 → G1 → G2`; G3/G4 và phần shell G5 có thể làm song song trên DTO ổn định. G6/G7 dùng chung renderer và version, cần phối hợp. G8 nghiệm thu theo từng lát cắt hoàn chỉnh, không phải đợi làm hết backlog mới dùng được.

## 7. Lát cắt nên đưa vào sử dụng trước

| Đợt | Giá trị cho vận hành | Điều kiện bắt buộc |
|---|---|---|
| A | Bảng cập nhật nhanh; tìm/lọc; đổi thông tin/ảnh; lock/gỡ; pass đúng quyền | G1 các lỗi liên quan, G2, G3; ảnh dùng pipeline và draft chắc chắn |
| B | Cọc nhanh nhất quán, bổ sung/gắn khách/sửa hạn; web và Hermes | Đóng D1–D4; kiểm tiền/quyền/race; receipt phục hồi được |
| C | Hàng loạt, chính sách đồng nhất, link đúng scope, tin chờ gửi tự kiểm thông tin mới | Version/partial receipts; W6/H4/H5 và public-field tests |
| D | Chương trình có điều kiện; duyệt đề nghị; chuyển phòng/chuyển cọc chuyên biệt; phễu lead/hẹn xem | Chốt nhu cầu và writer riêng; không ghép hủy+tạo để giả lập chuyển tiền |

Đợt A không được bỏ qua lỗi tiền nếu màn hình đang hiển thị sai cảnh báo cọc. Sửa lỗi hiện hành có thể phát hành trước tính năng giao diện mới. Không cần chờ chương trình marketing đầy đủ mới đưa bảng nhanh vào dùng.

## 8. Các quyết định sản phẩm và mặc định đề xuất

| Quyết định | Mặc định đề xuất cho đợt đầu | Khi nào cần thay đổi |
|---|---|---|
| Ai cập nhật trực tiếp? | Sale Admin/quản lý có quyền theo tòa được ghi; sale thiếu quyền gửi đề nghị | Tổ chức muốn sale tự cập nhật một số trường |
| Mọi thay đổi có phải duyệt? | Chỉ dùng duyệt cho người thiếu quyền hoặc loại thay đổi được cấu hình; không thêm duyệt vào mọi sửa nhỏ | Giá hàng loạt, chương trình, công khai thông tin khách hoặc tài chính cần đúng quyền/quy trình |
| Chủ báo trống nhưng hợp đồng còn ở? | Ghi thông tin báo + yêu cầu xử lý; chưa gắn “trống sẵn” | Hoàn tất báo trả/bàn giao đúng nguồn |
| Liên hệ khách pass | Mặc định quản lý; công khai khách khi có xác nhận đúng người/số | Khách thu hồi hoặc đổi hợp đồng thì đánh giá lại |
| Lock PASS | Giữ hạn chế hiện có | Thiết kế riêng trách nhiệm giữa chủ, khách cũ và khách mới |
| Ảnh áp nhiều phòng | Mặc định ghép và preview; cho chọn thay rõ ràng | Người dùng chủ động chọn thay toàn bộ |
| Link của nhân viên | Chỉ mở sau khi xác định owner/scope đại diện | Nếu chưa đủ contract, giới hạn chức năng theo quyền owner thay vì suy đoán |
| Nhiều chính sách cùng lúc | Công bố thứ tự ưu tiên rõ; chương trình cấu trúc mặc định không cộng dồn nếu chưa khai báo | Người có quyền khai báo cho cộng dồn và mức trần |
| Hết hạn cọc | Nhắc xử lý, giữ nguyên tiền/claim | Hủy/quyết toán qua writer được phép |
| Cập nhật nhanh đến sale | Đọc lại ngay sau lưu, truyền invalidation/realtime theo scope; polling dự phòng | Đo tải và SLA để chọn cơ chế; không hứa độ trễ khi chưa đo |

Những mặc định này phục vụ thiết kế, chưa áp dụng vào dữ liệu/quyền production.

## 9. Điều kiện nghiệm thu cuối

- Phân quyền đúng cả nguồn/đích, tổ chức/tòa/quỹ; thu hồi quyền sau preview vẫn chặn commit.
- Đủ 6 cặp cạnh tranh cọc/lock trọng yếu và UI–Hermes sửa đồng thời trên PostgreSQL nhiều connection; chỉ một claim hợp lệ.
- Cảnh báo cọc dùng đúng nhận tiền; giữ/hủy/hoàn/ký không tạo hoặc nhận trùng nguồn.
- Nguồn kỳ hạn mới và legacy có quy tắc rõ; danh sách, hồ sơ và Hermes hiển thị cùng nghĩa.
- Mất phản hồi trước/sau DB/provider/finalize có đường tra cứu; không retry mù hoặc đổi requestId để gửi lại.
- Không mất draft, không ghi đè âm thầm; bulk có kết quả từng đối tượng.
- Public JSON, UI, ảnh và tin không lộ trường nội bộ hoặc liên hệ bị thu hồi.
- Bộ cập nhật nhanh đạt Q01–Q12 trên máy tính và điện thoại; đo bằng tác vụ thực, không chỉ snapshot.
- Tin chờ gửi được kiểm lại khi phòng lock/cọc/đổi giá/chính sách; nội dung đã gửi có thời điểm và link thông tin hiện hành.
- Các phép kiểm theo Contract/risk map/test matrix của diff cuối đạt; build/CI/review thực hiện theo lane phát hành phù hợp.

## 10. Làm song song với phần Claude đang hoàn thiện

Có thể tách nhánh/worktree để làm song song sau khi thống nhất giao diện dữ liệu. Hai bên không nên cùng sửa file chung hoặc tự thay nghĩa trạng thái.

| Luồng | Phạm vi sở hữu | Bàn giao |
|---|---|---|
| Claude – đọc dữ liệu | Reader, projection, SQL đọc, read parity | SHA, DTO/version, nghĩa trường, fixture và kết quả kiểm |
| Nghiệp vụ ghi | Writer/forward migration, quyền, tiền, receipt | Action contract, lỗi/receipt, regression và migration evidence |
| UI nhanh | Bảng/drawer/mobile/draft/bulk | Dùng contract chung, không tạo fact tiền/trạng thái riêng |
| Hermes actions | Module tool/service/adapter mới | Giữ authority và read/write boundary hiện có |
| Worker | Nội dung, freshness, giao hàng | Render parity, kết quả gửi và phục hồi |
| Người tích hợp | Registry/broker/server/fact/types/manifests chung | Kiểm diff tích hợp cuối, tránh kiểm lặp đầu vào không đổi |

File chung cần một người tích hợp: `broker.mjs`, `server.mjs`, `capability-contract.mjs`, `domain-contract.mjs`, `web-parity.json`, `roomSaleFacts.ts`, generated types và test/risk manifests khi cần. Không tối ưu đường ghi bằng cách bỏ kiểm quyền/session chỉ vì đường đọc đang dùng cache.

Đợt kiểm này nằm trong worktree riêng `C:/Users/Nguyen Tam/codex-worktrees/sale-phong-action-audit-20261021`; không sửa WIP trong checkout chính. Chưa có bằng chứng trạng thái hiện tại của phiên Claude, nên không khẳng định Claude đã hoàn tất hoặc thay đổi của Claude đã nằm hết trong SHA được kiểm.

## 11. Phát hành và phạm vi chưa làm

Thực hiện theo `docs/engineering/PROJECT_CONTRACT.md` và `DATA_ENVIRONMENTS.md`: thay đổi quyền/tiền/migration qua draft PR và review phù hợp; migration forward, kiểm trên TEST/dữ liệu giả hoặc DEMO được xác nhận. Tên link `/r/demo` không chứng minh tổ chức đó là dữ liệu DEMO.

Không sửa dữ liệu tổ chức thật để thử. Không dùng kết quả PGlite làm giấy chứng nhận production. Giữ kết quả kiểm của input không đổi; khi tích hợp làm đổi writer/fact/DTO thì chạy lại đúng kiểm liên quan. Không cần tự thêm vòng full-repo/build vào báo cáo chỉ có tài liệu này.

Chưa xác minh đầy đủ: JWT/PostgREST/RLS và ACL thực; race nhiều connection; ghi UI/Hermes thật; upload/download end-to-end; gửi nhóm Zalo thử; đối soát tiền/quỹ thật; độ trễ và tải; mobile của mọi màn; SHA frontend đang triển khai. Các giới hạn này được ghi cụ thể trong TEST-RESULTS và phải được đóng ở gói nghiệm thu tương ứng.
