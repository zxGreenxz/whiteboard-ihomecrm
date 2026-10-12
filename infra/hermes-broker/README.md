# Hermes broker — thử nghiệm P1

Broker chạy bằng Node 22, chỉ dùng thư viện chuẩn. Đây là spike xác minh danh tính, giới hạn quyền và MCP; chưa phải dịch vụ production hay bộ lập lịch.

```text
Hermes — opaque token → Broker — bearer user → Supabase Auth / RPC đọc cố định
                             ↓
                   đối chiếu lại quyền trước khi trả
```

`createBroker` nhận trusted auth adapter, kho session/connection/assistant và audit adapter ở backend. `issueConnection` nhận access token đã đăng nhập, không nhận mật khẩu. HTTP MCP không có endpoint cấp token, sửa quyền hay gọi RPC tùy ý. Người vận hành trusted backend chịu trách nhiệm cho phép ai được gọi control plane; P2 sẽ cung cấp giao diện và policy quản trị.

Token Hermes có entropy 256 bit và chỉ lưu hash ở kho connection. Access token Supabase nằm riêng tại session store, không xuất hiện trong MCP, kết quả hay receipt. Mỗi user–company có assistant ID riêng; reconnect trong cùng store giữ ID, credential mới độc lập. Người thường chỉ được có một công ty hợp lệ; superadmin vẫn phải có membership hợp lệ ở công ty đang chọn.

Quyền hiệu lực là giao của quyền CRM hiện tại, trần công ty và restriction connection; đọc và thao tác là hai tập độc lập. Tool duy nhất là `crm_auth_context`, arguments `{}`, trả identity, effective permissions và `contextVersion` không chứa secret. `assistant.context.read` là quyền self-context của spike, không phải permission mới đã thêm vào database. `rooms.view` trong kết quả chỉ là bit thông tin đã xác minh; spike không cung cấp tool đọc phòng hoặc thao tác nghiệp vụ.

`supabase-adapter.mjs` gọi `/auth/v1/user` rồi ba RPC cố định qua bearer user và publishable key: `get_authorization_context_v1`, `get_my_organizations`, `copilot_org_scope_buildings_v1('rooms.view', org)`. RPC scope bắt buộc membership ACTIVE, chưa revoke, còn hạn. Nó bổ sung phần kiểm thiếu trong RPC context/directory cũ. Direct SELECT own memberships không được dùng vì RLS hiện tại không cho user thường đọc. Directory có nhiều membership ACTIVE cũ được xác minh từng công ty qua strict gate; trên 16 ứng viên của user thường sẽ từ chối. Không cấp service-role và không vượt RLS.

Mỗi request được giữ suất quota trước network auth, kiểm quyền trước và sau khi chuẩn bị kết quả. Token expiry, connection epoch, authority epoch, thay đổi quyền hoặc revoke giữa chừng đều chặn trả kết quả cũ. `contextVersion` cho supervisor so sánh admission trước/sau một turn; broker không tự thu hồi nội dung model đã nhận trước đó. Audit chỉ lưu metadata cố định, trạng thái prepared/denied/timeout; custom sink lỗi thì không trả dữ liệu thành công. `prepared` chỉ có nghĩa đã chuẩn bị phản hồi, không chứng minh dữ liệu đã giao. Sau khi audit hoàn tất, broker kiểm lại quyền từ nguồn hiện tại; nếu quyền đổi, cùng requestId sẽ có thêm receipt denied. Mặc định giữ 1.000 receipt trong RAM, không phải audit bền vững.

P1 chỉ giữ access token ngắn hạn trong RAM, tối đa 15 phút; không refresh, không đăng nhập nền và không khôi phục sau restart. Assistant identity mặc định cũng chỉ bền trong vòng đời store. Interface `MemorySessionStore` là điểm thay bằng encrypted server store và refresh single-writer ở P2; `MemoryConnectionStore.replace` yêu cầu compare-and-swap; `MemoryAssistantStore.getOrCreate` cần unique user–company ở kho bền vững. Không tái sử dụng refresh token của phiên web. Không mount store/secrets vào Hermes.

`createMcpHttpServer` cung cấp stateless JSON Streamable HTTP subset tại `POST /mcp`: initialize, notifications/initialized, ping, tools/list, tools/call. Không SSE, batch, subscriptions, session lifecycle hay OAuth issuer. Bearer sai/revoked trả HTTP 401; tool bị chặn trả MCP `isError: true`. Host/Origin allowlist, body cap và global concurrency là lớp transport. Chỉ bind loopback hoặc private test network; khi triển khai ngoài máy phải có TLS, authentication/control-plane hoàn chỉnh và ingress giới hạn. Không có CLI tự lấy credential môi trường.

Fixture `createFixtureBroker()` chỉ dành cho kiểm offline, trả `{broker, connections: {a, b}}` với hai user/công ty tổng hợp. Không dùng fixture làm auth provider thật.

Kiểm focused:

```powershell
node --test infra/hermes-broker/broker.test.mjs infra/hermes-broker/mcp-http.test.mjs infra/hermes-broker/supabase-adapter.test.mjs
```

Các phép kiểm offline không chứng minh catalog/RLS live, Hermes upstream thật, isolation container hay triển khai production. Harness JWT TEST và runtime isolation do các lane riêng cung cấp bằng chứng.
