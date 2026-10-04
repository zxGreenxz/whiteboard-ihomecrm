# Worker email ACB

Worker Node độc lập cho OAuth Gmail, Pub/Sub và đối soát thư ACB. Package này chưa được kích hoạt trên môi trường nào. Nó không chứa token, thư ACB thật hoặc cấu hình Google Cloud. Quyết định ghi thu và quyền hiện tại nằm trong RPC `bank_email_worker_v1`/writer V5; worker chỉ gửi giao dịch đã xác minh và tiến độ đồng bộ.

## Chạy và kiểm thử

Yêu cầu Node >=22.19.0. Trong thư mục repository:

```sh
npm ci --prefix services/bank-email-worker
npm test --prefix services/bank-email-worker
```

Nạp biến trong `.env.example` bằng secret manager của môi trường chạy, rồi `npm start --prefix services/bank-email-worker`. Worker nghe `127.0.0.1:8080` theo mặc định; chỉ đặt `BANK_EMAIL_BIND_HOST=0.0.0.0` khi có lớp ingress TLS và giới hạn mạng phù hợp. `GET /health` chỉ trả `{ "ok": true }`. `POST /oauth/start` nhận Bearer Supabase JWT và `{ "connectionId": "uuid" }`, trả `{ "url": "https://accounts.google.com/..." }`. Callback OAuth: `GET /oauth/callback`. Pub/Sub: `POST /pubsub`.

Ứng dụng web dùng proxy cùng origin `/api/bank-email/oauth/start` tới worker, cấu hình server `BANK_EMAIL_WORKER_URL` là origin HTTPS của worker, `APP_ORIGIN` là origin HTTPS của web và client `VITE_BANK_EMAIL_WORKER_URL=/api/bank-email`. Proxy chuyển `Origin` bằng `APP_ORIGIN`. Nếu gọi worker trực tiếp từ trình duyệt, phải cho phép đúng host worker trong CSP của web. Không đặt service key, OAuth secret hay khóa AES trong `VITE_*`.

## Kích hoạt Google Cloud

1. Bật Gmail API, tạo OAuth web client, khai chính xác redirect URI `${BANK_EMAIL_PUBLIC_URL}/oauth/callback`; khai scope `https://www.googleapis.com/auth/gmail.readonly`. Đây là [restricted scope](https://developers.google.com/workspace/gmail/api/auth/scopes); kiểm quy trình xác minh ứng dụng và đánh giá bảo mật của Google trước khi dùng ngoài nhóm thử. Google cho biết refresh token của ứng dụng external ở trạng thái **Testing** hết hạn sau bảy ngày đối với scope này ([OAuth guide](https://developers.google.com/identity/protocols/oauth2)).
2. Tạo Pub/Sub topic trong cùng Google project, cấp `roles/pubsub.publisher` trên topic cho `gmail-api-push@system.gserviceaccount.com` theo [Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push).
3. Tạo push subscription tới `${BANK_EMAIL_PUBLIC_URL}/pubsub`, bật xác thực OIDC bằng service account riêng. Đặt audience chính xác bằng `GOOGLE_PUBSUB_AUDIENCE`, cấp quyền mint ID token cho Pub/Sub service agent theo [Pub/Sub authenticated push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions). Worker kiểm chữ ký JWT, issuer, audience, email và `email_verified` trước khi ACK. HTTP 204 chỉ sau `enqueue` bền vững; lỗi DB trả 503 để Pub/Sub gửi lại.
4. Cấp secret ở server: Supabase anon key để chuyển tiếp JWT người cấu hình, service role key cho RPC worker, OAuth client secret và một khóa AES-256-GCM 32 byte (`BANK_EMAIL_TOKEN_KEY_BASE64`). Giữ khóa AES ổn định hoặc thiết kế quy trình xoay khóa có giải mã và mã hóa lại token trước khi đổi. Cấu hình Google phải được kiểm trên project TEST riêng trước production.
5. Bật worker dưới process supervisor với restart và log chỉ gồm mã lỗi đã lọc. Gmail watch được gia hạn xấp xỉ mỗi ngày; lịch sử được kiểm lại mỗi năm phút. [Gmail yêu cầu gia hạn watch ít nhất mỗi bảy ngày](https://developers.google.com/workspace/gmail/api/guides/push). Khi history hết hạn, worker quét Gmail theo trang, lưu page token bền vững, rồi đồng bộ từ snapshot history để lấy thư đến trong lúc quét.

## Vận hành và giới hạn

- Mỗi kết nối gắn một Gmail và tài khoản ACB; DB giữ ánh xạ duy nhất. `disconnect` làm DB dừng tự ghi ngay và worker thu hồi refresh token qua Google. Worker không gọi `users.stop` vì mailbox có thể có cấu hình khác. Thu hồi grant Google có thể ảnh hưởng mọi kết nối dùng cùng grant; `invalid_grant` chuyển trạng thái cần kết nối lại.
- Parser chỉ nhận mẫu số dư ACB tiếng Việt/Anh đã ràng buộc, khoản VND nguyên, tài khoản và hậu tố `GD <mã> <ddmmyy-HH:mm:ss>` ở cuối nội dung; hai ngôn ngữ phải khớp. `bankReference` là chuỗi `GD:<mã>:<ddmmyy-HH:mm:ss>`, không lấy mã FT trong phần người chuyển ghi làm khóa nguồn. Xác minh DKIM thực sự trên raw MIME từ Gmail, yêu cầu signer `acb.com.vn`, khóa RSA tối thiểu 2048 bit, đúng một From `mailalert@acb.com.vn`, không chấp nhận `l=` và yêu cầu các header MIME quyết định nội dung được ký. `Authentication-Results` trong thư không phải bằng chứng. HTML được chuyển thành text tại chỗ, không tải ảnh, link hoặc attachment. Thư lớn, sai chữ ký, sai mẫu hoặc thiếu nội dung đi vào hàng chờ, không tự ghi thu.
- Thư gốc ACB có thể dùng MIME/header/template khác mẫu giả lập; trước khi bật auto trên dữ liệu thật cần kiểm `.eml` do người vận hành cung cấp ngoài Git trên môi trường TEST, xác minh DKIM DNS thật và đối chiếu số tiền/tài khoản/mã tham chiếu. Không đặt `.eml` thật vào repo hoặc log. Chưa kiểm luồng Google live, Pub/Sub live, thư ACB live, độ trễ gửi từ ngân hàng hoặc ghi tiền production.
- Leases của DB dài 120 giây; mỗi Gmail/DB request có timeout 10 giây và worker đặt deadline 80 giây để chừa thời gian cho lưu lỗi/retry. Worker đọc metadata `From` trước để bỏ qua thư không phải ACB mà không tải raw hoặc tạo hàng chờ. Metadata chỉ là bộ lọc: mọi thư ứng viên vẫn phải qua DKIM/From trên raw MIME trước khi được coi là xác minh. Thư ứng viên vượt giới hạn raw được lưu chờ duyệt với mã `RAW_SIZE_LIMIT`, rồi cursor tiếp tục.
- Worker lưu `page_progress` sau mỗi thư đã ingest hoặc bỏ qua có chủ ý, truy vấn `page_pending` theo lô tối đa 500 ID để tiếp tục giữa một trang history/scan kể cả khi trang có hơn 1.000 thư. Cursor chỉ tiến sau khi cả trang xong; thư trùng được DB khử theo message/source claim. Pub/Sub có thể gửi trùng hoặc sai thứ tự; payload chỉ đánh thức đồng bộ từ cursor DB.
