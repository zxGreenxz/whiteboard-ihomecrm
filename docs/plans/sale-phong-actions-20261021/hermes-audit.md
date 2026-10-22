# Rà soát Hermes và kênh gửi Sale Phòng — 21/10/2026

Snapshot được đọc: `c095d427e`. Tài liệu này ghi kết quả đọc source và đề xuất hợp đồng thao tác; **không chứng minh các RPC đã được triển khai trên production**. Root điều phối tập test chung và giữ kết quả; agent phụ chạy thêm đúng một proof H5 gồm 2 ca bằng dữ liệu giả, kết quả ở §10. Không sửa mã sản phẩm, gửi tin Zalo hoặc ghi DB live trong phần rà soát này.

## 1. Kết luận kỹ thuật

Phần Sale Phòng đã có nhiều nghiệp vụ ở CRM, nhưng tập thao tác Hermes hiện hẹp hơn giao diện. Hermes đã có tạo/sửa/bật/ẩn tin khách nhờ sale và điều khiển gửi ảnh phòng trống Zalo. Chưa có tool Hermes chuyên biệt cho lock tạm, nhận cọc/giữ chỗ, cập nhật ảnh, cập nhật thông tin phòng thông thường, cấu hình trang sale hoặc quản lý link chia sẻ.

Không nên xây một bộ trạng thái phòng và bộ tiền riêng trong Hermes. Mỗi tool mới phải gọi writer chuẩn của CRM dưới JWT người dùng, giữ đúng quyền/tòa/phiếu tiền, trả biên nhận thật và có đường đối soát khi mất phản hồi. Cùng hợp đồng thao tác phải được UI và Hermes sử dụng.

Phần đọc Claude đang hoàn thiện được giữ như một dependency có version. Có thể làm song song adapter ghi, form UI, tests và tài liệu; các file dùng chung cần một người tích hợp để tránh ghi đè.

## 2. Năng lực có sẵn, đúng giới hạn của source

| Nghiệp vụ | Source đã có | Giới hạn cần giữ |
|---|---|---|
| Đọc danh sách phòng đang đăng | `crm_available_rooms`; legacy `hermes_sale_listing_rooms_v1`, chế độ page `hermes_available_rooms_page_v1` | Nguồn là trang sale đã có link còn hiệu lực, không phải mọi phòng CRM. Không có trang sale khác với hết phòng. Lọc quyền `rooms.view` và scope kết nối. |
| Tra phòng để đăng pass | `crm_room_lookup` | Bị ràng buộc quyền **quản lý pass**, không phải lookup chung cho mọi action. Tra cả phòng đang thuê; nhiều kết quả phải làm rõ phòng/tòa. |
| Tạo/sửa pass | `crm_room_pass_upsert` → `hermes_room_pass_upsert_v2` → writer `upsert_room_pass_listing` | Chỉ một phòng. Sửa tin đang hiện; không có tin đang hiện thì tạo tin mới. Bỏ trường hoặc chuỗi trống giữ giá trị; `null` xóa. Không thay hợp đồng, khách thuê, trạng thái phòng. |
| Bật/ẩn pass | `crm_room_pass_observe`, `crm_room_pass_set_active` | Bắt buộc revision vừa đọc; thông báo conflict khi trạng thái đã đổi. |
| Đối soát pass | `crm_room_pass_status` | Dùng đúng requestId ban đầu. `not_found` không cho phép tự tạo một requestId mới để ghi lại. |
| Gửi Zalo một lần/hẹn giờ | `crm_zalo_broadcast_recipients`, `crm_zalo_broadcast_send`, `crm_zalo_broadcast_status`, `crm_zalo_broadcast_cancel` | Chỉ nhóm công ty đánh dấu sale; 1–50 nhóm/lượt; full/compact; một lần trong 30 ngày. “Đã xếp hàng” chưa phải “đã gửi tới Zalo”. |
| Lịch gửi Zalo | `crm_zalo_broadcast_update` | Dùng lịch CRM hiện có, expectedVersion, ngày/giờ và nhóm nhận; không tạo cron riêng của Hermes. Không tự gỡ dừng khẩn cấp. |
| Ảnh gửi Zalo | Worker lấy ảnh sale qua storage hiện có, bảo toàn thứ tự, đóng gói album | Đây là **đọc ảnh để gửi**, không phải tool cho người dùng cập nhật ảnh phòng. Hơn 12 ảnh/album hiện từ chối gửi phòng, không cắt âm thầm. |

Nguồn chính:

- `infra/hermes-broker/broker.mjs:47`: tập tool được đăng ký.
- `infra/hermes-broker/room-read-service.mjs:320`: các RPC đọc danh sách sale.
- `infra/hermes-broker/room-read-projection.mjs:15`, `:73`, `:123`, `:180`: phân biệt không có trang sale; trình bày trạng thái/giá/chính sách và phân trang.
- `infra/hermes-broker/room-pass-contract.mjs:4`, `:17`, `:24`, `:147`: action, DTO và mô tả hành vi pass.
- `infra/hermes-broker/room-pass-adapter.mjs:30`: lookup/upsert đi v2; status có đường tương thích biên nhận v1.
- `supabase/migrations/20261015162454_hermes_room_pass_upsert_v1.sql:239`: gọi writer pass chuẩn.
- `infra/hermes-broker/zalo-broadcast-contract.mjs:8`, `:23`, `:267`: quyền, giới hạn và tool Zalo.
- `worker/lib/automation.js:458`, `:486`: dựng nội dung/album gửi từ ảnh hiện có.

## 3. Khoảng trống và điểm cần quyết định

### H1 — Chưa có hợp đồng ghi cho phần lớn thao tác Sale Phòng qua Hermes

Đăng ký tool trong `broker.mjs:47` có pass và broadcast; không có tool lock/reservation/media/settings/share. Các hành vi này đã tồn tại ở hook UI nhưng chưa thành API hành động Hermes.

Hệ quả: người dùng “lock phòng 12 giờ”, “đã nhận cọc”, “thay ảnh bìa” không nên bị trả lời như thể đã thực hiện. Khi bổ sung tool cần trả `unsupported`/thiếu quyền rõ ràng trước khi writer sẵn sàng.

### H2 — Lookup pass không dùng chung được cho người chỉ có quyền lock/cọc

`room-pass-contract.mjs:17` chỉ cho dùng lookup khi effective action có `sale_phong.manage_pass_listings`. SQL còn giao quyền đọc và quyền quản lý pass. Một nhân viên có quyền lock hoặc nhận cọc nhưng không được quản lý pass sẽ không tra phòng qua tool này được.

Đề xuất: resolver mới theo action đích, chỉ trả đối tượng trong giao scope tương ứng; không nới quyền `crm_room_lookup` cũ. Kết quả cần roomId, buildingId, nhãn phân biệt, phiên bản/trạng thái và lý do action không khả dụng.

### H3 — Pass upsert có idempotency nhưng chưa có optimistic concurrency cho sửa nội dung

`room-pass-contract.mjs:24` không có expectedRevision cho upsert; SQL `20261015162454...:215` khóa dòng rồi cập nhật trường được cung cấp. Cách này tránh ghi đồng thời cùng dòng trong một giao dịch nhưng không phát hiện “preview cũ, UI đã sửa, Hermes ghi lại nội dung cũ”. `set_active` đã có expectedRevision.

Đề xuất khi mở sửa toàn bộ thông tin: bổ sung writer version mới có expectedRevision cho update; create phải phân biệt rõ “chưa tồn tại” với “vừa có người khác tạo”. Không sửa migration đã áp dụng. Chỉ gửi trường người dùng muốn đổi.

### H4 — Nội dung broadcast đã xếp hàng không được đối chiếu lại với trạng thái phòng trước gửi

Đã xác nhận bằng source, chưa tái hiện bằng live/test mới:

- `worker/lib/automation.js:458` dựng ảnh/body từ một snapshot.
- `worker/lib/automation.js:181` tạo requestKey và xếp payload để gửi sau theo nhịp.
- `worker/lib/queue.js:78` kiểm `validateAutomationDelivery` trước provider.
- `worker/lib/automation-delivery.js:11` kiểm lịch, người nhận, phạm vi, ngày, khung giờ, dừng khẩn cấp; không đọc lại phòng/giá/chính sách/link.
- SQL provider fence `20261016110539_zalo_broadcast_oneshot_review_fixes_v1.sql:64` cũng kiểm lease, nhóm, lịch, quota và stop; không kiểm revision phòng.

Ca cần xử lý: đã xếp tin lúc 09:00, 09:01 phòng nhận cọc hoặc bị lock, 09:05 tin cũ còn chờ mới gửi. Cần chốt quy tắc: hủy nội dung pending đã lỗi thời và tạo lại lượt mới theo quyền/giới hạn; không sửa tin đã gửi như thể chưa từng gửi. Gắn roomIds, phiên bản nội dung và thời điểm nguồn vào job; ảnh bảng chứa nhiều phòng cần version tập dữ liệu, không chỉ từng phòng. UI/Hermes hiển thị “xếp hàng / đã gửi / bị hủy vì dữ liệu đổi / chưa xác minh”.

### H5 — Chính sách pass trên tin chi tiết Zalo khác bảng

`worker/lib/room-list-table.js:79` và `room-read-projection.mjs:95` ưu tiên saleNote rồi fallback passSalePolicy cho phòng pass. `worker/lib/automation.js:92` chỉ truyền saleNote vào `{khuyen_mai}`. Vì vậy pass policy có thể có trên bảng ảnh/Hermes nhưng thiếu trong tin chi tiết. Mẫu mặc định còn không chứa `{khuyen_mai}`.

Cần chốt tin chi tiết phải có điều kiện nào; tạo một fact/policy renderer chung và test cả mẫu mặc định lẫn mẫu tùy chỉnh. Đã tái hiện trên các hàm production export bằng dữ liệu giả: bảng giữ nguyên passSalePolicy, tin chi tiết dùng mẫu có `{khuyen_mai}` vẫn chỉ ra `Khuyến mãi:`. Ca đối chứng có saleNote thì cả hai đều giữ nội dung. Chứng cứ ở §10; chưa kiểm tin production đã gửi.

### H6 — Ghi tay tình trạng cần kiểm đúng phạm vi áp dụng

Web `src/pages/phong-trong/roomListTable.ts:82` ưu tiên `saleStatusNote`. Worker `worker/lib/room-list-table.js:44` và mapper `worker/lib/vacant-rooms.js:91` không có nhánh tương ứng. Cần xác định chữ này chỉ là bản nháp bảng ảnh của UI hay là dữ liệu bán công khai có chủ ý phải đi qua mọi kênh. Không tự lấy chữ ghi tay để thay trạng thái hợp đồng/cọc.

### H7 — Không nhầm cập nhật ảnh hiện có với một giao dịch bulk nguyên tử

`src/components/sale-phong/SaleImagesTab.tsx:136` cập nhật phòng chính, sau đó `:142` cập nhật phòng tương tự bằng lời gọi riêng. UI có báo partial và liệt kê phòng đã xác nhận. Không được bọc hai lần gọi này trong Hermes rồi báo “đã cập nhật tất cả” khi lần sau lỗi.

Đề xuất writer dùng chung với per-room revision và receipt. Với bulk: mỗi phòng có kết quả applied/conflict/forbidden/unknown; tiếp tục và thử lại theo đúng requestId của từng phần. Việc lưu ảnh tệp và gắn ảnh vào phòng là hai bước có cleanup artifact mồ côi.

### H8 — “Chính sách/chương trình” hiện chủ yếu là chữ

`src/hooks/usePublicRoomSettings.ts:10` có chính sách sale chung cấp tài khoản; phòng có sale_note; pass có sale_policy. Những trường này chưa biểu diễn đầy đủ một chương trình có ngày hiệu lực, điều kiện thuê, phạm vi tòa/phòng, ưu tiên/cộng dồn và điều khoản kết thúc. Tiền thưởng sale nội bộ cũng không được trộn vào nội dung công khai; worker chủ động không lấy sale_bonus_note (`worker/lib/vacant-rooms.js:13`).

Đề xuất triển khai theo hai bước: quản trị chữ và phạm vi đúng trước; nếu chủ trọ cần tự động áp dụng/đối soát chương trình thì thêm mô hình chương trình có cấu trúc và version, không dùng LLM suy ra hiệu lực từ đoạn văn.

## 4. Hợp đồng thao tác mới đề xuất

Các tên tool dưới đây là **đề xuất, chưa tồn tại**.

| Tool/họ thao tác | Writer/đường CRM tái dùng | Input nghiệp vụ và kiểm bắt buộc | Receipt và hậu kiểm |
|---|---|---|---|
| `crm_sale_room_resolve` | Reader scope theo action, dùng fact trạng thái chung | Toà + phòng + action đích; không nhận organization/user tùy ý từ model; không đoán UUID | candidates, allowedActions, denialReasons, expectedRevision; nhiều phòng phải làm rõ |
| `crm_sale_lock_create` | `lock_room_for_sale_v1` | roomId, hours ∈ 6/12/24, note ≤300, requestId; `sale_phong.lock_room` tại tòa | lockId, expiresAt từ server, active; đọc public page thấy phòng không còn được chào |
| `crm_sale_lock_release` | `release_room_sale_lock_v1` | lockId, requestId; người tạo còn quyền hoặc `deposits.create`; phân biệt hết hạn/đã nhả | lý do MANUAL/EXPIRED/RESERVED và tình trạng hiện tại |
| `crm_reservation_create` | `create_room_reservation_v1` | roomId; customerId hoặc customerHint; hạn, ngày vào; receipt có tiền hoặc existingVoucherIds; requestId ánh xạ idempotencyKey | reservationId, revision, source vouchers, approval_status, received_amount, còn thiếu; không nói “đã nhận tiền” khi chưa received |
| `crm_reservation_update/topup/cancel/assign_customer` | `update_room_reservation_v1`, `assign_room_reservation_customer_v1` | expectedRevision; requestId; action/changes chính xác; không hủy khi nguồn cọc còn hiệu lực | history/revision; cọc/voucher giữ liên kết; dẫn đến luồng hoàn/quyết toán khi cần |
| `crm_room_pass_*` mở rộng | Writer pass hiện có, migration mới cho OCC | Giữ semantics bỏ trường/null; phân biệt pass và chuyển hợp đồng | receipt hiện có, revision, contactSource; chữ công khai đi qua preview hiện tại |
| `crm_sale_room_update` | Service + writer chuẩn quản lý room; cần tách DTO khỏi component | Trường giá/mô tả/diện tích/nội thất/ngày sẵn sàng đúng mô hình; expectedRevision; không đổi trạng thái thuê tùy tiện | diff trước/sau và reader public xác nhận; không cài “trống ngay” cho phòng còn hợp đồng |
| `crm_sale_media_prepare/commit/reorder/remove` | `src/lib/storage.ts`, storage R2/resilient hiện có + writer gắn media | Chứng cứ người dùng cung cấp, roomId, checksums, mediaId; phạm vi org; kích thước/MIME; thứ tự/ảnh bìa; revision | uploaded khác published; commit trả danh sách ảnh đã gắn; không xóa blob dùng chung trước kiểm tham chiếu |
| `crm_sale_settings_update` | Writer dùng chung thay direct `public_room_settings` upsert | owner/page scope rõ, expectedRevision, trường soon_days/hotline/policy; chú ý hiện cấp tài khoản | thông tin phạm vi thực và bản xem trước; nội dung công khai áp rào chữ |
| `crm_sale_share_create/update/revoke` | `create_public_room_token` và writer share token | Chọn đúng owner/trang, label, requestId; thu hồi đúng token | link thật, trạng thái, effects; retry create không sinh thêm link |
| `crm_sale_program_*` | Chưa có mô hình chuẩn đầy đủ | Phạm vi, ngày hiệu lực +07, tiền/điều kiện, priority/cộng dồn, draft/published/ended | version và policy render đồng nhất; giữ giá thuê/hợp đồng gốc trừ khi người dùng yêu cầu đúng luồng |
| `crm_zalo_broadcast_*` tăng độ tươi | Writer/lịch CRM có sẵn | giữ recipient UUID, quyền send/manage, quota, stop; thêm nguồn/version nội dung | phân biệt queued/delivered/failed/unknown; hủy content stale |

Nguồn canonical lock: `src/lib/roomSaleLockRpc.ts:22`, `:28`, `:61`; `20261010114500...sql:353`, `:395`, `:423`.

Nguồn reservation: `src/lib/reservationIdentityRpc.ts:11`, `:25`, `:34`; `src/hooks/useRoomReservations.ts:9`.

Lưu ý lock hiện có một phép tái dùng ngắn: cùng người, cùng số giờ/ghi chú và dưới 2 phút trả lock cũ (`20261010114500...sql:375`). Đây không thay thế idempotency theo requestId bền vững. Wrapper mới phải lưu receipt cùng giao dịch với writer, đồng thời giữ thứ tự khóa phòng → tổ chức hiện có để tránh deadlock.

## 5. Hợp đồng nền cho mọi tool ghi

1. **Authority:** giao quyền CRM hiện tại × quyền kết nối Hermes × policy org × scope tòa; kiểm lại lúc ghi. Không union scope từ các quyền khác; không suy quyền ghi từ quyền đọc.
2. **Identity:** actor, org, connection, token/session revision chỉ được backend lấy từ kết nối; model chỉ gửi ID đối tượng đã resolve.
3. **Intent:** schema strict, chỉ trường biết rõ; tiền VND số nguyên; mốc ngày/giờ không mơ hồ; không sử dụng thiếu dữ liệu như yêu cầu xóa.
4. **Concurrency:** expectedRevision của đúng đối tượng; lỗi conflict có DTO đọc lại, không tự áp toàn bộ patch cũ.
5. **Idempotency:** requestId do `crm_new_request_id` cấp (`request-id-contract.mjs:12`); cùng mã + cùng payload trả receipt; cùng mã + payload khác từ chối.
6. **Unknown:** tách rejected khỏi outcome_unknown sau dispatch. Lệnh status/reconcile đọc receipt không phát sinh side effect. Không tạo mã mới để né timeout.
7. **Public text:** tái dùng cơ chế `public-text-guard.mjs:14`; tên/điện thoại/chính sách đang yêu cầu preview nguyên văn, token một lần 10 phút. Phần mới phải khai báo trường công khai và kiểm đúng đối tượng/nội dung. Đây là hành vi hệ thống hiện có.
8. **Multi-step:** trả progress từng bước và IDs đã hoàn thành; riêng cọc, hold terms, thưởng sale, media upload không gộp lời hứa thành công toàn phần nếu writer chưa atomic.
9. **Read-back:** kiểm receipt và đọc projection có quyền, phân biệt đã lưu dữ liệu với đã xuất bản/đã gửi. Không dùng tài khoản service_role thay người dùng để vượt RLS.
10. **Audit:** actor/connection/requestId/object/before-after phiên bản, không ghi toàn bộ số điện thoại/ảnh/bằng chứng tiền vào log kỹ thuật.

## 6. Ca nghiệm thu Hermes + UI cần bổ sung

| Nhóm | Tình huống | Kết quả phải đúng trên cả UI và Hermes |
|---|---|---|
| Resolve | Toà trùng tên, phòng 101 trùng nhiều tòa, có dấu/không dấu, mã khác tên | Chọn đúng đối tượng; hỏi phần định danh thiếu; không tự lấy phòng đầu |
| Resolve | Phòng đã xóa mềm, tòa ảo, ngoài org, ngoài phạm vi kết nối | Không lộ dữ liệu và không ghi; lý do đúng |
| Quyền | Có rooms.view nhưng không có action; có action A không có B; hết quyền giữa preview và commit | Không ghi; token/preview không nâng quyền |
| Lock | 6/12/24h; nhả thủ công; hết hạn đúng clock server; retry <2 phút và >2 phút | Một lock theo intent; không kéo dài hạn khi retry; phòng quay lại đúng điều kiện |
| Lock | Hai người cùng lock; nhận cọc trong lúc lock; lock phòng đã cọc/đang thuê/pass | Chỉ một claim hợp lệ; cọc kết thúc lock; giữ đúng giới hạn nghiệp vụ hiện tại |
| Cọc | Có customerId / chỉ customerHint / khách mới / tên trùng | Hint chỉ khi có tiền, phải gắn khách thật trước ký hợp đồng |
| Cọc | Tạo phiếu chờ duyệt, duyệt thu, nhận thiếu, bổ sung, chuyển nguồn đã có | Không đếm chờ duyệt là tiền đã nhận; không gắn tiền hai phòng |
| Cọc | Hết hạn ký hợp đồng vs hết hạn bổ sung; ngày vào sau ngày báo trả | Tách các mốc, không tự mất tiền hoặc nhả claim trái nghiệp vụ |
| Cọc | Hủy/hoàn/mất cọc khi nguồn tiền còn hiệu lực | Hướng vào luồng quyết toán; không xóa nguồn để “bỏ giữ phòng” |
| Pass | Tạo, sửa một trường, xóa bằng null, chuỗi trống giữ; bật lại tin ẩn | Không tạo tin trùng khi người dùng muốn bật tin cũ; revision conflict rõ |
| Pass | Có khách đại diện nhưng người dùng không cung cấp liên hệ | Auto-fill nhưng public liên hệ quản lý; trả contactSource đúng |
| Pass | Thiếu năm, ngày sai, giá “3tr5”, nhiều căn trong một tin | Chuẩn hóa/cho thấy ngày năm đã chọn; tách từng phòng; không gộp thông tin nhầm |
| Media | Không ảnh, 1/12/>12 ảnh, thêm/đổi thứ tự/bìa/xóa; ảnh sai MIME hoặc hỏng | Bảo toàn thứ tự; giới hạn kênh rõ; không tự thay ảnh tòa vào ảnh phòng |
| Media | Link hết hạn, upload xong nhưng commit lỗi, một phòng bulk cấm quyền | Giữ artifact và kết quả từng phòng để đối soát; không báo hoàn thành tất cả |
| Policy | Chung/tòa/phòng/pass cùng tồn tại, có hiệu lực tương lai, hết hạn | Quy tắc ưu tiên rõ và nhất quán trên trang/link/bảng ảnh/tin chữ/Hermes |
| Policy | Thưởng sale nội bộ vs ưu đãi công khai | Không lộ hoa hồng nội bộ qua group/public; ghi đúng trường |
| Broadcast | Đổi lock/cọc/giá/policy/link sau enqueue nhưng trước gửi | Pending nội dung cũ bị hủy hoặc rebuild có receipt mới; không chào phòng đã cọc |
| Broadcast | Nhóm đổi nick/org, bỏ sale flag, rút quyền, dừng khẩn cấp, mất session | Chặn trước provider; kết quả refused/failed/unknown đúng |
| Broadcast | Retry lúc mất ACK, restart giữa album/thông tin, hết quota giữa phòng | Không gửi lại tin có thể đã gửi; không cắt album im lặng; biết phần đã xếp/gửi |
| Kênh | Desktop và mobile cùng sửa một phòng; Claude reader thay contract | DTO version/parity bắt mismatch; không có bản UI mới đọc schema cũ âm thầm |

Ví dụ câu lệnh nghiệm thu tổng hợp:

- “Lock P101 tòa A 12 giờ để khách xem, chưa nhận tiền.” → lock, không tạo khách/phiếu.
- “Anh Bình đã chuyển cọc P101 tòa A 1 triệu vào quỹ X; tổng cọc 3 triệu, bổ sung ngày 25/10, dự kiến vào ngày 01/11.” → cần xác định khách/quỹ và mốc năm; tạo đúng reservation + source receipt, báo trạng thái duyệt/nhận thực.
- “Phòng 202 tòa A khách nhờ pass 3,5 triệu, trống 1/11, điện nước theo tin này; để quản lý nghe máy.” → lookup, preview phần chữ, upsert có contactManager.
- “Thay ảnh bìa P101 bằng ảnh vừa gửi, giữ các ảnh còn lại.” → upload/validate, reorder theo mediaId; không replace toàn bộ danh sách cũ.
- “Từ đầu tháng sau giảm 300 nghìn trong hai tháng đầu cho phòng studio tòa A; không áp vào hợp đồng đã ký.” → chương trình có kỳ và scope, không tự sửa rent_price của hợp đồng.
- “Gửi bản đầy đủ lúc 9 giờ sáng mai đến nhóm sale X, nếu phòng nhận cọc trước khi gửi thì bỏ phòng đó.” → schedule CRM, nội dung lấy tại lúc chạy và fence freshness trước provider.

## 7. Các đợt thực hiện và điều kiện hoàn thành

### Đợt A — Chốt hợp đồng dùng chung

- Chốt status/fact graph của CRM, phân biệt lock, hold chưa tiền, cọc chờ duyệt, cọc đã nhận, pass và báo trả.
- Viết DTO action/readback, revision, requestId/status; permission matrix theo tòa.
- Chốt source precedence cho giá, ngày trống, liên hệ, chính sách và chữ ghi tay.
- Tạo fixture contract test UI ↔ API ↔ Hermes; freeze interface reader từ công việc Claude.

Xong khi mọi action có writer/permission/source truth được chỉ tên; thiếu writer được đánh dấu, chưa mở tool.

### Đợt B — Lock tạm + quản lý pass

- Tool action-specific resolver, lock create/release/status; receipt transactional.
- Pass upsert OCC và đường hiện lại tin cũ rõ ràng; thống nhất UI conflict/reconcile.
- Giữ public text confirmation hiện tại; bổ sung tests state-change và quyền.

Xong khi lost ACK/concurrent UI/expiry/public page đã được kiểm trên fixture và môi trường TEST/DEMO phù hợp.

### Đợt C — Cọc/giữ chỗ theo writer chuẩn

- Create/update/topup/cancel/assign customer + status.
- Tách trạng thái phiếu tiền, hạn bổ sung, hạn ký, hoa hồng; không dựng ledger mới.
- UI dùng cùng service/receipt contract và deep link chứng từ.
- Test mutation permission/org/tiền; draft PR và review theo Contract.

Xong khi luồng tiền và claim có chứng cứ atomic/idempotent, partial có chỗ tiếp tục an toàn.

### Đợt D — Thông tin, ảnh, link và chính sách

- Tách ghi khỏi component thành service/writer có kiểm quyền/OCC.
- Media pipeline prepare → upload → attach → verify, bulk trả từng phòng.
- Quản trị chính sách chữ hiện tại; chương trình có cấu trúc là hạng mục tách nếu cần.
- Public text preview, public link và export parity cho desktop/mobile.

Xong khi cùng thay đổi hiển thị nhất quán qua trang sale/link/bảng/Hermes, không rò dữ liệu nội bộ.

### Đợt E — Broadcast và nghiệm thu xuyên kênh

- Thêm content revision/freshness vào pending jobs; policy cho nội dung thay đổi giữa các phần album.
- Sửa lệch pass policy/tình trạng đã xác nhận và thêm tests hồi quy.
- Đo receipt gửi thật trên tài khoản nhóm DEMO được phép; production giữ lane riêng.
- UI và Hermes đều trả đúng queued/sent/partial/unknown.

Xong khi kịch bản nhận cọc/lock/đổi ảnh sau enqueue không làm gửi thông tin phòng cũ và mất phản hồi không gây spam trùng.

## 8. Chia việc song song với Claude

| Luồng | Sở hữu chính | Vùng tránh sửa đồng thời |
|---|---|---|
| Claude đọc dữ liệu | Reader contract, projection, SQL read/parity; bàn giao SHA và test evidence | `room-read-service.mjs`, `room-read-projection.mjs`, `domain-contract.mjs`, read SQL |
| Writer CRM | Migration forward mới, receipts, permission/atomicity, action DTO | Không vá migration đã áp dụng; không tự đổi reader semantics |
| Hermes actions | Các module mới `sale-*-contract/adapter/service`, tests riêng | `broker.mjs`, `server.mjs`, capability registry do một integrator ghép |
| UI Sale Phòng | Components/hooks/services theo DTO đã chốt; mobile/desktop feedback | Không nhúng thêm trạng thái tiền/room truth độc lập |
| Worker | Freshness, media delivery, render parity | Chạm shared fact renderer có phối hợp với reader owner |
| Integrator | Registry/capability, generated types, web-parity, test matrix, schema surfaces | Một người tích hợp các file chung và chạy phép kiểm đúng input cuối |

File chung cần single owner: `infra/hermes-broker/broker.mjs`, `server.mjs`, `capability-contract.mjs`, `web-parity.json`; `src/lib/roomSaleFacts.ts`; generated Supabase types; `tooling/test-matrix.json`/risk map nếu phải cập nhật. Tái dùng receipt xanh của input không đổi; chỉ chạy lại khi nhánh đã tích hợp thay source liên quan.

## 9. Tập test đã chuyển cho root

Node native:

- `infra/hermes-broker/room-pass-*.test.mjs` (gồm SQL fixture, composition, metadata, upsert, full-read và mutation).
- `infra/hermes-broker/sale-listing-sql.test.mjs`.
- `infra/hermes-broker/room-read-service.test.mjs`, `room-read-projection.test.mjs`.
- `infra/hermes-broker/zalo-broadcast-*.test.mjs`.
- `infra/hermes-broker/public-text-guard.test.mjs` khi gom đầy đủ rào chữ công khai.

Vitest:

- `worker/__tests__/lifecycle-sale.test.js`.
- `worker/__tests__/automation-room-image.test.js`.
- `worker/__tests__/automation-scenario.test.js`.
- `worker/__tests__/automation-helpers.test.js`.
- `worker/__tests__/automation-engine.test.js`.
- `worker/__tests__/automation-delivery.test.js`.
- `worker/__tests__/room-list-table-parity.test.js`.

Tập sẵn có có giá trị cho contract/SQL fixture, idempotency, scope, privacy, media và điều khiển lịch. Không thay thế kiểm provider thật, Supabase/RLS live, album native, concurrency hai kết nối DB thật, browser UI hay stale-content test mới nêu ở H4. Không được suy luận production đã đầy đủ từ tên test hoặc chú thích migration.

## 10. Proof H5 đã chạy bằng hàm production

Thời điểm: 00:49 ngày 21/10/2026 (+07). Lệnh chạy từ worktree:

```powershell
node "docs/plans/sale-phong-actions-20261021/proofs/run-pass-policy-proof.mjs"
```

Kết quả runner: **1 file, 2 ca đạt; exit 0**. Đây là proof xác nhận **lệch dữ liệu đang tồn tại**, không phải hai ca chứng minh sản phẩm đã đúng.

- Hàm production `soanTinPhong` lấy nguyên từ `worker/lib/automation.js`.
- Hàm production `buildRoomListTable` lấy nguyên từ `worker/lib/room-list-table.js`, tức dữ liệu policy thật cấp vào bộ vẽ ảnh.
- Chỉ mock ctx/ảnh canvas để ngăn I/O; không mock hai renderer.
- Ca tái hiện: status pass, saleNote rỗng, passSalePolicy có chữ. Table row.policy giữ đầy đủ; tin detail có mẫu `Khuyến mãi: {khuyen_mai}` trả đúng `Khuyến mãi:`; mẫu mặc định cũng không có chính sách.
- Ca đối chứng: cung cấp saleNote thì cả bảng và tin detail lấy đúng saleNote.
- Không có DB/network/provider calls; không render PNG, vì điểm mất dữ liệu đã nằm trước bước vẽ/gửi.

Artifact:

- `proofs/pass-policy.proof.mjs`: ca tái hiện và đối chứng, chỉ dùng dữ liệu giả.
- `proofs/run-pass-policy-proof.mjs`: runner chỉ thu đúng một file proof.
- `proofs/pass-policy-observations.json`: input, output và SHA256 ba source đã dùng.
- `proofs/pass-policy-vitest-result.json`: kết quả máy sinh của Vitest.
