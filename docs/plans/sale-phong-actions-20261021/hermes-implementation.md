# Bàn giao Hermes Sale — bản local

Đã triển khai 10 tool: tìm nhãn phòng theo quyền thao tác; observe phiên bản; patch thông tin/ảnh; lock/gỡ lock; tạo cọc/thu thêm/sửa/gắn khách; đối soát requestId. Không có tool hủy cọc, hoàn tiền hoặc ký hợp đồng.

Mỗi ghi chạy caller JWT qua admission đầy đủ, ràng buộc phiên/kết nối/membership/policy và scope hiện tại. SQL bọc writer CRM hiện hành; biên nhận riêng cùng transaction, kiểm lại quyền khi replay/status. `APPROVED` không suy ra đã nhận: trả riêng `received` và `receivedAmount`. Observe vẫn cần quyền CRM xem phòng của inventory, đồng thời có quyền sửa/ảnh; ảnh-only chỉ nhận trường ảnh.

Chữ công khai mới đi qua preview/token một lần. Riêng patch, token ràng buộc toàn bộ input, gồm room/revision/requestId. Giá, ảnh và ghi chú thưởng nội bộ không kích hoạt rào chữ công khai. Tool ảnh chỉ nhận URL HTTPS đã tải lên.

H4: fingerprint của projection public hiện có và template được gắn vào queue cùng transaction qua enqueue v2. Trước mỗi provider request, worker đọc lại RPC public worker của đúng organization; thay đổi phòng/lock/cọc/giá/ảnh/chính sách/template chặn nội dung cũ. Không đổi requestKey hoặc ghi đè job cũ khi retry. Job legacy thiếu fingerprint bị chặn, cần dựng lượt mới. Đây là kiểm ngay trước provider call; không phải cam kết thu hồi một tin đã được provider nhận hoặc loại bỏ khoảng chạy đồng thời sau kiểm.

## Kiểm đã chạy

- Native Node 24: 62 test của sale action, composition, SQL boundary/options, public-text guard và connection management: PASS.
- H01–H24: 24 yêu cầu từ chủ trọ, quản lý, chủ công ty, Sale Admin và Sale: PASS. Mapping JSON và JUnit XML ở `docs/plans/sale-phong-actions-20261021/hermes-acceptance-*`. Đây là input đã được resolve rõ ràng, không phải kiểm hiểu ngôn ngữ tự nhiên của LLM.
- PostgreSQL local thật: HP01–HP12 PASS, authority và writer canonical không stub. Kết quả `hermes-local-postgres-results.json`; fixture chỉ tạo tenant/actor/session giả lập riêng, thay platform auth NULL stubs bằng claims local. HP07 thực tế có `approvalStatus=APPROVED`, `received=false`, `receivedAmount=0`.
- Đồng thời web/Hermes: HC01–HC06 PASS trên hai kết nối PostgreSQL thật, có `pg_blocking_pids` xác nhận giao dịch sau đang chờ giao dịch trước. Bao gồm lock→cọc, cọc→lock, hai patch cùng revision, patch→cọc, hai topup cùng revision, và thu hồi kết nối trong lúc Hermes đang đợi khóa phòng. Script riêng `scripts/test-hermes-sale-concurrency-local.mjs`; kết quả `hermes-concurrency-postgres-results.json`. “Web” ở đây là gọi đúng writer canonical của giao diện bằng actor authenticated, chưa phải thao tác trình duyệt/HTTP.
- Worker: 11 test H4 mới + 21 delivery + 40 engine: PASS.
- SQL queue metadata: 4 ca riêng + test cha (runner báo 5): PASS; atomic guard, replay không thay guard cũ, rollback guard sai, browser roles bị chặn.
- Client org policy: 35 test: PASS.

Không chạy provider Zalo thật, HTTP JWT thật, LLM thật, deploy hoặc remote writes. Native SQL wrapper tests dùng canonical writer stubs để kiểm boundary; HP01–HP12 bổ sung writer thật trên PostgreSQL riêng.

## Phối hợp Claude

Không sửa `bound-user-operation.mjs`, `domain-contract.mjs`, `domain-mount.mjs`, full-read, wave2, name-resolution, `mcp-http.mjs`, `vacant-rooms.js` hoặc các read projection.

Các hunk giao nhau cần gộp thủ công:

- `broker.mjs`: import/catalô Sale tools; thêm port `saleActions`, filtering catalogue, dispatcher riêng; thêm mã lỗi unknown. Không đổi nhánh domain reader.
- `server.mjs`: thêm sale capability auth vào chuỗi full authority và mount service; readAuthority riêng giữ nguyên.
- `capability-contract.mjs`: thêm đúng 5 action key, không đổi read keys.
- `public-text-guard.mjs`: thêm patch và chuỗi tiện nghi; `bindAllFields` chỉ cho patch. Pass cũ giữ semantics.
- `connection-management.mjs`, `src/hermes/orgPolicyClient.ts`: gọi options/context v8, fallback v7 chỉ khi PGRST202. v8 SQL bao ngoài v7 hiện có, không thay v7.
- `src/hermes/capabilityLabels.ts`: nhãn các action mới, diễn giải thu chi/approve bao gồm cọc.
- `worker/lib/automation.js`: import/content guard/enqueue v2; không sửa lại hunk chính sách pass H5 của root.
- `worker/lib/automation-delivery.js`: sau các check hiện hành gọi content guard.

Hai migration mới: `20261020183546_hermes_sale_actions_v1.sql`, `20261020184631_zalo_broadcast_content_guard_v2.sql`. Registry action seed ở trạng thái tắt; dữ liệu bật trong test chỉ thuộc DB local. Cần migration trước worker v2; không fallback enqueue thiếu guard.
