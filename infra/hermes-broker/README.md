# Hermes broker — nền xác thực và lưu phiên

Broker spike chạy bằng Node 22 và thư viện chuẩn; adapter PostgreSQL mới dùng `pg`. Đây là phần xác minh danh tính, giới hạn quyền và MCP; chưa phải dịch vụ production hay bộ lập lịch.

```text
Hermes — opaque token → Broker — bearer user → Supabase Auth / RPC đọc cố định
                             ↓
                   đối chiếu lại quyền trước khi trả
```

`createBroker` có hai chế độ: P1 nhận auth adapter và các memory store; P2 nhận `authority` bền vững. Cả hai dùng chung dispatcher, quota, tool và audit. P2 không tạo hoặc fallback memory store; các method issue/revoke/restrict P1 bị chặn, quản trị đi qua control plane riêng. HTTP MCP không có endpoint cấp token, sửa quyền hay gọi RPC tùy ý. Giao diện liên kết và control plane sản phẩm còn đang triển khai.

Token Hermes có entropy 256 bit và chỉ lưu hash ở kho connection. Access token Supabase nằm riêng tại session store, không xuất hiện trong MCP, kết quả hay receipt. Mỗi user–company có assistant ID riêng; reconnect trong cùng store giữ ID, credential mới độc lập. Người thường chỉ được có một công ty hợp lệ; superadmin vẫn phải có membership hợp lệ ở công ty đang chọn.

Quyền hiệu lực là giao của quyền CRM hiện tại, trần công ty và restriction connection; đọc và thao tác là hai tập độc lập. Tool duy nhất là `crm_auth_context`, arguments `{}`, trả identity, effective permissions và `contextVersion` không chứa secret. `assistant.context.read` là capability self-context riêng; không thay đổi quyền CRM của user. `rooms.view` trong kết quả chỉ là bit thông tin đã xác minh; spike không cung cấp tool đọc phòng hoặc thao tác nghiệp vụ.

`supabase-adapter.mjs` gọi `/auth/v1/user` rồi ba RPC cố định qua bearer user và publishable key: `get_authorization_context_v1`, `get_my_organizations`, `copilot_org_scope_buildings_v1('rooms.view', org)`. RPC scope bắt buộc membership ACTIVE, chưa revoke, còn hạn. Nó bổ sung phần kiểm thiếu trong RPC context/directory cũ. Direct SELECT own memberships không được dùng vì RLS hiện tại không cho user thường đọc. Directory có nhiều membership ACTIVE cũ được xác minh từng công ty qua strict gate; trên 16 ứng viên của user thường sẽ từ chối. Không cấp service-role và không vượt RLS.

Mỗi request được giữ suất quota trước network auth, kiểm quyền trước và sau khi chuẩn bị kết quả. Token expiry, connection epoch, authority epoch, thay đổi quyền hoặc revoke giữa chừng đều chặn trả kết quả cũ. `contextVersion` cho supervisor so sánh admission trước/sau một turn; broker không tự thu hồi nội dung model đã nhận trước đó. Audit chỉ lưu metadata cố định, trạng thái prepared/denied/timeout; custom sink lỗi thì không trả dữ liệu thành công. `prepared` chỉ có nghĩa đã chuẩn bị phản hồi, không chứng minh dữ liệu đã giao. Sau khi audit hoàn tất, broker kiểm lại quyền từ nguồn hiện tại; nếu quyền đổi, cùng requestId sẽ có thêm receipt denied. Mặc định giữ 1.000 receipt trong RAM, không phải audit bền vững.

P1 chỉ giữ access token ngắn hạn trong RAM, tối đa 15 phút; không refresh, không đăng nhập nền và không khôi phục sau restart. P2 dùng identity unique user–company và session mã hóa trong DB, activation nguyên khối thay cho chuỗi put/create/delete của spike. Không tái sử dụng refresh token của phiên web. Không mount store/secrets vào Hermes.

`durable-authority.mjs` đọc connection theo token hash để giữ suất quota, sau đó giải mã AAD, xác minh Auth, đọc quyền CRM và đối chiếu lại DB. Broker giữ receipt gốc cho lần kiểm cuối sau audit; không đổi connection sau khi giữ suất. `supabase-durable-auth-adapter.mjs` tái dùng adapter P1, thêm metadata membership/version và scope tòa theo từng quyền; đọc HTTP có giới hạn byte/deadline. Scope `authorization_scopes.id` trong giới hạn trợ lý khác ID tòa/sổ của CRM; chưa mở business tool trước khi có adapter ánh xạ đúng từng quyền.

`createMcpHttpServer` cung cấp stateless JSON Streamable HTTP subset tại `POST /mcp`: initialize, notifications/initialized, ping, tools/list, tools/call. Không SSE, batch, subscriptions, session lifecycle hay OAuth issuer. Bearer sai/revoked trả HTTP 401; tool bị chặn trả MCP `isError: true`. Host/Origin allowlist, body cap và global concurrency là lớp transport. Chỉ bind loopback hoặc private test network; khi triển khai ngoài máy phải có TLS, authentication/control-plane hoàn chỉnh và ingress giới hạn. Không có CLI tự lấy credential môi trường.

Fixture `createFixtureBroker()` chỉ dành cho kiểm offline, trả `{broker, connections: {a, b}}` với hai user/công ty tổng hợp. Không dùng fixture làm auth provider thật.

Kiểm focused:

```powershell
node --test infra/hermes-broker/broker.test.mjs infra/hermes-broker/mcp-http.test.mjs infra/hermes-broker/supabase-adapter.test.mjs
```

Các phép kiểm offline không chứng minh catalog/RLS live, Hermes upstream thật, isolation container hay triển khai production. Harness JWT TEST và runtime isolation do các lane riêng cung cấp bằng chứng.

## Nền P2 đang kiểm tích hợp

`session-crypto.mjs` mã hóa AES-256-GCM; AAD gắn assistant/user/org/session và phiên bản khóa. Khóa được cấp từ backend tin cậy, không đọc môi trường hoặc ghi đĩa trong module. Có kiểm envelope, giới hạn kích thước, rotation/rewrap và hủy bản sao khóa. Không truyền khóa hoặc ciphertext sang runtime Hermes.

`refresh-manager.mjs` yêu cầu store tuyến tính hóa bảy thao tác acquire/markDispatched/stageRefresh/publishRefresh/requireReconnect/release/revoke. Lease, fence và revision phải được bảo đảm bởi kho thật; mock test không thay cho transaction database. Phải ghi DISPATCHED trước khi gọi provider; STAGED chưa cho đọc. Stage/publish chỉ được gọi thêm một lần khi mất ACK, với đúng claim và ciphertext cũ. Không gọi lại provider hoặc retry một từ chối đã rõ. Chỉ ACK thu hồi xác định mới trả `session_reconnect_required`; sau dispatch mà kết quả vẫn chưa rõ trả `refresh_outcome_unknown`, caller dừng tác vụ và không dùng credential/cache cũ. ACTIVE mới đã commit vẫn là quyết định của DB; broker khác chỉ được đọc sau kiểm Auth/quyền hiện tại. Không suy lỗi mạng của caller thành thu hồi toàn hệ hoặc chứng minh phục hồi sau crash.

`durable-refresh-store.mjs` ánh xạ bảy thao tác này sang SQL cố định và kiểm response. `durable-connection-store.mjs` có activate/readConnection/restrictConnection/revokeConnection; activation nguyên khối, không dùng chuỗi put/create/delete bù của memory spike. Adapter kiểm canonical UUID/AAD, response và CAS; không tự cấp quyền, mint token, giải mã hay retry. SQL kiểm intent do user xác thực tạo và quyền hiện hành. Read trả encrypted bundle cho backend; caller còn phải giải mã và xác minh Auth/quyền CRM trước sử dụng. Thu hồi connection không tự xóa session của connection khác.

Refresh nhận `AbortSignal` của caller. Hủy trước provider không được gọi provider; sau DISPATCHED phải đối soát/cách ly bằng deadline độc lập, không dùng signal đã hủy để bỏ qua cleanup. Focused manager/adapter 57/57 đạt; đây chưa phải kiểm toàn tuyến với provider và DB cùng chạy.

`connection-control-plane.mjs` tạo phiên Auth mới phía backend bằng đăng nhập độc lập, xác minh cùng user nhưng khác phiên trình duyệt, đọc lại quyền, tạo intent rồi activation nguyên khối. Không nhận cặp access/refresh token do browser bàn giao, không refresh một phiên đang được quản lý ngoài lease. Mật khẩu không đi vào kho mã hóa, log, kết quả hoặc runtime; lỗi/challenge không hỗ trợ phải chặn. Hạn opaque dùng thời điểm prepare của database và clock host, chọn mốc sớm hơn; không tăng trần SQL 15 phút khi lệch giờ. Primitive có 25/25 focused tests; HTTP/TLS route, UI và xử lý phiên đăng nhập có ACK không rõ còn thiếu.

`connection-management.mjs` là primitive quản lý riêng, chưa mở HTTP/MCP. Nó đọc danh sách/context bằng JWT của user, kiểm đúng chủ và công ty, đối chiếu lại vai trò/membership/version/quyền hiện tại, rồi mới thu hẹp hoặc thu hồi bằng CAS. Context được đọc lại sau kiểm quyền cuối; hết hạn trước ghi không được dispatch, hết hạn sau dispatch trả kết quả chưa rõ và không retry. 28/28 focused tests đạt; chưa có kiểm TEST toàn tuyến cho management hoặc UI. Danh sách hiện bị giới hạn 256 dòng/128 KiB và từ chối nếu vượt, chưa phân trang. Thu hồi khi user đã mất membership cần luồng offboarding riêng; metadata ACTIVE không chứng minh runtime đang hoạt động.

`model-relay.mjs` là transport nội bộ đến `llm-proxy`, mặc định không cho model nào. Caller phải cung cấp context đã xác minh; module không có HTTP route hoặc quyền tự chọn actor/org. Chỉ nhận publishable key dạng `sb_publishable_`, không nhận service key hoặc anon JWT cũ. JWT user chỉ được dùng ở backend. Proxy hiện có giữ provider key, kiểm entitlement và tính usage; relay không tạo ngân sách khác. Request có giới hạn, không stream, không tự retry khi phản hồi mất; response được project và tool phải thuộc request đã gửi. Đây chưa phải bằng chứng quota đồng thời hoặc settlement đúng một lần của proxy.

```powershell
node --test infra/hermes-broker/session-crypto.test.mjs infra/hermes-broker/refresh-manager.test.mjs infra/hermes-broker/model-relay.test.mjs
```

Ba migration SQL (identity/policy, store, sửa giới hạn regex ciphertext) đã apply qua forward lane trên TEST, có backup và evidence riêng. Harness tích hợp đạt 18/18 với login riêng, JWT thật, lưu bền/thu hồi, broker và cấp phiên độc lập; cleanup và hash đầu vào không đổi đã xác minh. Kiểm còn tuần tự, chưa chứng minh cạnh tranh nhiều transaction hoặc provider refresh + store trong cùng luồng. Auth refresh thật có harness riêng với tài khoản tổng hợp và cleanup; chưa có HTTP/UI kết nối, model route hoặc business tool.

## Transport backend cho kho phiên

`supabase-refresh-provider.mjs` gọi đúng Auth refresh endpoint một lần, lọc token candidate và tái dùng `supabase-adapter` để xác minh bearer thật. Transport mặc định giới hạn byte và thời gian ở cả refresh và `/auth/v1/user`; verifier inject phải tự bảo đảm cùng hợp đồng. Manager vẫn phải đối chiếu user/session trước mã hóa. Module này không cấp phiên đăng nhập độc lập hoặc bảo đảm storage bền vững.

`store-transport.mjs` chỉ gọi 11 hàm private đã định danh bằng tham số JSON. Database login và current role phải cùng dedicated principal; từ chối postgres/service-role, đặc quyền và membership rộng. Write ACK không rõ trả `store_outcome_unknown`; caller phải đối soát bằng cùng operation/claim, không gọi lại provider. SQL ERROR xác định đã từ chối/rollback được trả mã denied/conflict/rejected; lỗi mạng/FATAL hoặc completion-unknown vẫn không rõ. Login, ACL và giao thức store tuần tự đã kiểm trên TEST; không suy ra cạnh tranh nhiều transaction hoặc vận hành production.

`store-pool.mjs` cố định TLS certificate verification, cổng session 5432, user/project binding, số kết nối và timeout. Không fallback credential, endpoint hoặc PGOPTIONS từ môi trường. Idle failure chỉ phát mã lỗi cố định. TLS thật đã kiểm với CA công khai ghim fingerprint trên TEST. Hiện dùng `pg` 8.16.3 ở dependency phát triển của repo; package/container triển khai broker còn phải khai dependency runtime.

```powershell
node --test infra/hermes-broker/supabase-refresh-provider.test.mjs infra/hermes-broker/store-transport.test.mjs infra/hermes-broker/store-pool.test.mjs
```

## Projection phòng trống đang chuẩn bị cho P3

`room-read-projection.mjs` chỉ lọc dữ liệu, chưa là tool hay phép cấp quyền. Nó tái dùng `roomSaleFacts.ts`, giữ đơn vị VND/null, giới hạn trường đầu ra và lọc bằng ID tòa đã được caller cho phép. Scope rỗng bị từ chối; tên tòa không mở rộng scope; chạm giới hạn nguồn 2.000 dòng phải báo chưa đầy đủ. Caller còn phải ánh xạ scope trợ lý, giao với scope `rooms.view`, gọi RPC bằng JWT thật và kiểm lại quyền trước trả kết quả. Chưa nối dữ liệu CRM vào Hermes.

10/10 focused tests đạt. Ba mutation bỏ lọc tòa, lộ field và bỏ từ chối scope rỗng đều bị test bắt; chạy trên bản sao cách ly, hash source không đổi. Chưa có proof đọc phòng xuyên broker hoặc gửi nhóm.
