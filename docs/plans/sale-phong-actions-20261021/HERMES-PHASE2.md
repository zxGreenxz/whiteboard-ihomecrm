# Hermes: cập nhật nhiều phòng và chính sách có thời hạn

Ngày kiểm: 21/10/2026. Phạm vi triển khai và kiểm thử chỉ ở worktree `sale-phong-action-audit-20261021` và PostgreSQL cục bộ `sale_quick_local` tại `127.0.0.1:55438`. Không triển khai, không ghi dữ liệu production.

## Kết quả hiện thực

Đã thêm hai công cụ cập nhật/đối soát nhiều phòng và bốn công cụ quan sát, lưu, dừng, đối soát chính sách. Không có luồng gửi đề nghị rồi chờ duyệt nghiệp vụ. Xem trước chữ công khai vẫn là xác nhận nguyên văn nội dung trong cùng thao tác; token chỉ dùng một lần trong 10 phút và ràng buộc toàn bộ đầu vào.

| Công cụ | Đầu vào chính | Hành vi |
| --- | --- | --- |
| `crm_sale_bulk_patch` | Mã lô, danh sách mã yêu cầu riêng, `roomId`, `expectedRevision` và trường sửa | Tối đa 10 phòng, 12 KiB JSON đã chuẩn hóa. Từng phòng dùng dịch vụ ghi với danh tính đầy đủ và giao dịch riêng. |
| `crm_sale_bulk_status` | Đúng mã lô và từng cặp `requestId`/`roomId` | Đối soát biên nhận của từng phòng; không tạo mã mới hoặc tự gửi lại lệnh ghi. |
| `crm_sale_policy_observe` | `roomId` | Lấy revision và chính sách trong phạm vi; vẫn cần quyền CRM xem phòng cùng quyền sửa theo tòa. |
| `crm_sale_policy_save` | `requestId`, phòng, revision, tiêu đề, nội dung, bắt đầu, kết thúc | Tạo trực tiếp chính sách bằng canonical RPC; không chồng thời hạn chương trình hiện hành/đã lên lịch. |
| `crm_sale_policy_cancel` | `requestId`, `policyId`, `expectedVersion`, lý do | Dừng theo version, giữ lịch sử; không hoàn tiền hoặc sửa giá hợp đồng. |
| `crm_sale_policy_status` | `requestId` | Đọc biên nhận đúng người dùng và kết nối sau khi kiểm lại quyền. |

Các trường bulk được phép: giá thuê, diện tích, loại phòng, tiện ích, ghi chú sale công khai, ghi chú thưởng nội bộ, mô tả, danh sách URL ảnh. Upload tệp ảnh vẫn qua luồng upload hiện có; công cụ này chỉ sửa metadata URL. Không có bulk thu tiền, bulk khóa phòng hoặc bulk chính sách trong đợt này.

Quyền sửa là `sale_phong.edit OR rooms.edit`, theo tòa. Lệnh chỉ sửa ảnh còn chấp nhận `sale_phong.manage_images`. Ghi chú thưởng nội bộ chỉ được trả khi có quyền sửa tại chính tòa đó. Không suy ra quyền xem từ quyền ghi; quan sát đi qua inventory có kiểm CRM view. Không suy ra quyền tạo/duyệt tiền từ quyền cập nhật thông tin.

Canonical migration cấp quyền cập nhật thông tin cho các vai trò được chỉ định: Chủ công ty, Chủ trọ, Quản lý tòa, Sale Admin và Sale, giữ phạm vi và deny hiện hữu. **Hermes capability mới vẫn mặc định tắt ở registry**; cần bật capability và chọn quyền/phạm vi ở chính sách công ty, kết nối trước khi sử dụng. Việc cấp CRM không tự kích hoạt Hermes.

## Biên nhận và trạng thái chưa rõ

- Mỗi item có UUID riêng, khác mã lô và không trùng item khác; mỗi phòng chỉ xuất hiện một lần. Mã lô dùng liên kết kết quả; biên nhận bền vững nằm ở từng item, không có một giao dịch nguyên tử cho cả lô.
- Revision phòng là chuỗi MD5 32 ký tự của canonical inventory, được xem như token opaque. Không tự tính phiên bản từ dữ liệu reader đã cache.
- Kết quả item có `applied`, `conflict`, `denied`, `invalid`, `unknown`, `not_attempted`, `not_found`. Lỗi rõ trước ghi có thể cho phép xử lý item sau; mất ACK hoặc phản hồi không xác nhận đúng sẽ là `unknown` và dừng các item còn lại.
- Một yêu cầu status bị từ chối hoặc context thay đổi vẫn không chứng minh lần ghi trước thất bại: kết quả bulk giữ `unknown` và dừng đối soát còn lại. `not_found` cũng không phải bằng chứng chắc chắn chưa ghi.
- Replay/status kiểm lại quyền cho chính thao tác đã lưu và đúng kết nối. Không dùng mã mới để xử lý mất phản hồi.
- Biên nhận policy save phải khớp phòng, nội dung đã chuẩn hóa như canonical `btrim`, thời điểm bắt đầu/kết thúc và version 1; cancel phải khớp policy ID, `CANCELLED`, version cũ + 1. Sai biên nhận không được báo thành công.
- Kiểm PostgreSQL thật phát hiện canonical patch trả `fields` là object, trong khi Hermes public contract yêu cầu danh sách tên trường. Wrapper mới xác thực object bằng đúng patch, rồi chuyển sang danh sách key có thứ tự. Replay/status biên nhận cũ chỉ được chuẩn hóa khi object khớp ý định đã lưu, sau kiểm quyền, không ghi lại nghiệp vụ.

## Bằng chứng kiểm thử

| Bộ kiểm | Kết quả | Giới hạn |
| --- | --- | --- |
| 9 tệp native Hermes liên quan: contracts, guard, control plane, options, server, latency, fallback | 155/155 PASS trước bổ sung ba regression cuối | Log `test-results/sale-quick-local/hermes-bulk-policy-native.log`; không cộng lần chạy lại vào tổng. |
| `sale-bulk-policy.test.mjs` cuối cùng | 15/15 PASS | Thay thế 12 case trong lượt 155; thêm fidelity policy, status unknown và broker composition. Contract/adapter với port giả lập, không phải đánh giá LLM. |
| `orgPolicyClient`, `connectionClient`, `HermesOrgPolicySettings` | 119 case cuối cùng xanh qua kết quả giữ lại và rerun tệp sửa | Hai tệp client 105 PASS giữ nguyên; settings 14/14 PASS sau sửa fixture v9. Lượt đầu settings 11 fail là fixture chưa nhận endpoint v9; không giấu lượt lỗi. |
| Durable schema + Copilot independence | 108/108 PASS | Kiểm ACL/private helper/call graph; sau sửa receipt chỉ chạy lại ba kiểm liên quan, 3/3 PASS. |
| `test-hermes-sale-policy-local.mjs` trên PostgreSQL thật | 12/12 PASS | Canonical writers và CRM authorization thật; session/records tổng hợp cục bộ. Bulk bridge dùng JS contract thật và SQL thật, authority JS được mô phỏng. Không gọi HTTP thật hay mô hình ngôn ngữ. |
| Timed-policy page forward: byte-equivalence và mutation proof | 2/2 PASS | Chỉ biểu thức sale note được phép khác; thay scope, room/org, clock, bound hoặc helper đọc tương lai đều làm proof đỏ. |
| Bộ parity page hiện hữu sau forward | 5/5 PASS | Admission FAST nguyên vẹn, vị từ/trạng thái/thứ tự/phân trang và các trường cho phép vẫn giữ. |
| `test-hermes-sale-policy-parity-local.mjs` trên PostgreSQL thật | 8/8 PASS | Canonical writer từ phía web, canonical public reader, Hermes legacy/page và hai formatter JS production; fixture thời gian được đặt trên dữ liệu local để kiểm trạng thái, không giả lập hàm auth/business. |

[Kết quả PostgreSQL từng yêu cầu](hermes-phase2-postgres-results.json). Các log chi tiết ở thư mục `test-results/sale-quick-local/` được ignore; JSON liên kết bên trên được giữ trong tài liệu bàn giao.

[Bằng chứng PostgreSQL public/legacy/page parity](hermes-policy-parity-postgres-results.json): HP01 chưa có policy, HP02 ACTIVE, HP03 chưa tới giờ, HP04 EXPIRED, HP05 CANCELLED, HP06 chuỗi dài, HP07 phân trang/phạm vi công ty-tòa, HP08 thu hồi quyền đọc. Ba nguồn dùng cùng chính sách effective. Hermes vẫn rút gọn transport 241 ký tự và hiển thị tối đa 240 theo contract hiện có; không khẳng định hiển thị đầy đủ toàn văn policy dài.

| ID | Yêu cầu đã kiểm và điều kiện |
| --- | --- |
| HB01–HB05 | Từng vai trò Chủ công ty, Chủ trọ, Quản lý, Sale Admin, Sale dùng quyền `sale_phong.edit` đã cấp rõ ràng để sửa thông tin/ghi chú nội bộ, tạo ACTIVE, đọc lại, exact replay, từ chối CAS cũ/chồng thời hạn, dừng và replay dừng. Fixture này không thay thế kiểm migration cấp mặc định của bộ DB. |
| HB06 | Ngoài tòa của kết nối hoặc khác công ty bị từ chối trước ghi, kể cả vai trò sở hữu. |
| HB07 | Đổi nội dung trên mã yêu cầu cũ hoặc session revision sai bị chặn. |
| HB08 | Sale edit không mở quyền tạo hồ sơ cọc/phiếu thu. |
| HB09 | Thu hồi quyền trên kết nối chặn status của biên nhận chính sách đã tồn tại. |
| HB10 | Bulk ba phòng: ghi thành công, CAS conflict, ngoài phạm vi denied; chỉ một receipt được lưu. |
| HB11 | Bulk mất ACK sau commit thực tế ở phòng thứ hai: phòng đầu applied, phòng hai unknown, phòng ba chưa chạy; status mã phòng hai xác nhận commit. |
| HB12 | Receipt patch lịch sử dạng object được chuẩn hóa đúng khi status/replay, không ghi lần hai; object sai nội dung bị chặn. |

## Phối hợp reader và giới hạn còn lại

Không sửa FAST/full-read, domain reader, wave-2, name resolution hoặc logic reader mà Claude đang làm. `broker.mjs` và `server.mjs` chỉ có phần đăng ký thêm dịch vụ/công cụ và chuỗi authorization action; khi ghép WIP của Claude cần giữ cả hai phần thêm này. Options/context nâng lên v9, fallback v8 đến v1; fixture optional RPC đã cập nhật để tránh request chờ endpoint không tồn tại.

Canonical migration sở hữu dữ liệu chính sách, thời gian `[start,end)`, nội dung công khai và giới hạn đọc. Legacy/group/schedule nhận chữ effective qua canonical public reader. Page RPC trước đó chép sale note trực tiếp từ phòng nên cần forward riêng `20261021072345_hermes_room_timed_policy_projection_v1.sql`: chỉ thay một biểu thức sale note bằng active text từ canonical helper tại `statement_timestamp()`, giữ giới hạn 241 ký tự. Toàn bộ admission, scope, predicate, thứ tự, phân trang, chữ ký và ACL giữ nguyên; proof so từng byte với baseline. Không sửa file reader của Claude hoặc generic FAST/domain reader. Map parity chỉ được cập nhật sau khi PostgreSQL thật và formatter JS xác nhận tương đương.

Worker đọc chữ sale effective từ canonical hiện có; thay đổi cache expiry công khai do agent DB/UI kiểm riêng. Không khẳng định generic FAST reader đã hỗ trợ mọi trường quản trị policy mới. Policy title/history/future content không được thêm vào schema public của Hermes page.

Chưa chạy tương tác bằng Hermes/Claude LLM thật, trình duyệt production, upload ảnh thật, gửi Zalo/provider thật hoặc kiểm triển khai. Mất ACK trong bộ này được tiêm sau commit cục bộ để kiểm semantics, không phải mất mạng production. Không thực hiện refund/ký hợp đồng qua công cụ mới.

## Tệp triển khai chính

- `infra/hermes-broker/sale-bulk-contract.mjs`, `sale-bulk-adapter.mjs`.
- `infra/hermes-broker/sale-policy-contract.mjs`, `sale-policy-adapter.mjs`.
- `infra/hermes-broker/sale-action-contract.mjs`, `public-text-guard.mjs`, `capability-contract.mjs`, phần đăng ký thêm trong `broker.mjs` và `server.mjs`.
- `supabase/migrations/20261021064112_hermes_sale_bulk_policy_v1.sql`: wrapper/receipt policy, forward action quyền mới và shape receipt, capability/options/context v9; phụ thuộc canonical `20261021063721_sale_room_timed_policy_v1.sql`.
- `supabase/migrations/20261021072345_hermes_room_timed_policy_projection_v1.sql`, `infra/hermes-broker/sale-policy-page-parity.test.mjs`, `scripts/test-hermes-sale-policy-parity-local.mjs`; cập nhật có căn cứ trong `web-parity.json` và assertion helper call của `available-rooms-page-parity.test.mjs`.
- `src/hermes/orgPolicyClient.ts`, `capabilityLabels.ts`, `infra/hermes-broker/connection-management.mjs` và các fixture v9 liên quan.
- `infra/hermes-broker/sale-bulk-policy.test.mjs`, `scripts/test-hermes-sale-policy-local.mjs`, ACL regression trong `scripts/__tests__/hermes-durable-schema.test.mjs`.
