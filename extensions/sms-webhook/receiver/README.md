# Receiver webhook cho VPS

Receiver nhận SMS và thông báo ứng dụng do điện thoại gửi, lưu nguyên payload vào SQLite trước khi trả thành công. Chưa có bộ lọc ngân hàng, hạch toán hoặc kết nối CRM. Không in nội dung tin nhắn, token hay lỗi SQLite ra log. Dữ liệu thử trong tests hoàn toàn giả lập.

Yêu cầu **Node.js 24.18.0** (ghim tại `.node-version`); dùng HTTP và SQLite tích hợp, không cần `npm install`. [Tài liệu SQLite của runtime này](https://nodejs.org/download/release/v24.18.0/docs/api/sqlite.html).

## Khởi động

Chạy với tài khoản dịch vụ riêng trên VPS Linux. `WEBHOOK_TOKEN` bắt buộc dài 32–256 ký tự, dùng chữ ASCII, số và `._~+/-`, có thể kết thúc bằng tối đa hai dấu `=` (mẫu `[A-Za-z0-9._~+/-]+={0,2}`). Nên sinh ngẫu nhiên 32 byte rồi mã hóa hex. App Android và VPS dùng cùng token. Nạp qua biến môi trường hoặc file `.env` quyền `0600`, không commit token.

Ví dụ cấu hình (thay giá trị token trước khi chạy):

```dotenv
WEBHOOK_TOKEN=REPLACE_WITH_RANDOM_TOKEN_BEFORE_STARTING
PORT=8787
DB_PATH=/var/lib/sms-webhook/events.sqlite
```

Tạo thư mục riêng `/var/lib/sms-webhook` thuộc tài khoản dịch vụ, quyền `0700`; file database được đặt quyền `0600`. Nếu bỏ `DB_PATH`, chương trình tạo `data/events.sqlite` bên cạnh `server.mjs`. Không đặt database trong thư mục web public. SQLite không mã hóa nội dung; bảo vệ ổ đĩa, bản sao lưu và quyền truy cập VPS, kể cả OTP đã chuyển theo cấu hình gửi tất cả tin.

```sh
node --env-file=.env server.mjs
```

Receiver chỉ lắng nghe `127.0.0.1:8787` (có thể đổi `PORT`). Đặt nginx cùng VPS phía trước với chứng chỉ HTTPS hợp lệ. App không gửi đến HTTP hoặc đi theo redirect.

```nginx
server {
    listen 443 ssl;
    server_name sms.example.com;
    ssl_certificate /etc/letsencrypt/live/sms.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sms.example.com/privkey.pem;

    location = /webhooks/sms {
        client_max_body_size 64k;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Idempotency-Key $http_x_idempotency_key;
        proxy_connect_timeout 5s;
        proxy_read_timeout 20s;
        proxy_next_upstream off;
        # Không cấu hình log chứa request body hoặc Authorization.
    }
    location / { return 404; }
}
```

Thay domain và đường dẫn chứng chỉ của bạn; URL nhập trên điện thoại là `https://sms.example.com/webhooks/sms`. `GET /health` chỉ dùng nội bộ trên loopback và trả `{"status":"ok"}` khi tiến trình hoạt động; không xác nhận khả năng ghi ổ đĩa hay luồng nhận tin hoàn chỉnh.

## Hợp đồng nhận dữ liệu

`POST /webhooks/sms` với `Content-Type: application/json; charset=utf-8`, `Authorization: Bearer <token>`, `X-Idempotency-Key: <id>`. Tổng JSON tối đa 64 KiB để đủ chỗ cho body 8192 byte khi ký tự điều khiển được escape. Không chấp nhận body nén hoặc header xác thực trùng.

```json
{
  "schemaVersion": 1,
  "event": "sms.received",
  "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "deviceId": "dc9c3d8a-468e-48bd-b50b-272bebd2c912",
  "sender": "DEMO",
  "body": "Nội dung thử nghiệm\nDòng thứ hai",
  "receivedAt": "2026-10-09T01:02:03.456Z",
  "subscriptionId": null
}
```

`gateway.test` dùng cùng các field như SMS. `notification.received` thay `sender` và `subscriptionId` bằng `packageName`, `appName`, `title`; các field chung giữ nguyên. Receiver kiểm tra đúng bộ field theo loại sự kiện; không chấp nhận field thừa.

`id` là 64 ký tự hex thường, trùng header idempotency; `deviceId` là UUID; `receivedAt` là thời điểm ISO8601 có múi giờ. `body` tối đa 8192 byte UTF-8, `sender` 256 byte, `packageName` 255 byte (không rỗng), `appName` và `title` mỗi field 512 byte. `subscriptionId` là số nguyên an toàn hoặc `null`.

| HTTP | Ý nghĩa |
| --- | --- |
| 201 | Đã lưu SQLite thành công |
| 200 | Đã nhận trước đó, cùng id và cùng payload; không ghi trùng |
| 400 / 413 / 415 | Payload, header hoặc kích thước không hợp lệ |
| 401 | Token không đúng |
| 409 | Id đã tồn tại nhưng payload khác; cần kiểm tra phía gửi |
| 503 | Chưa ghi được database; điện thoại có thể gửi lại |

Ứng dụng xử lý phía máy chủ có thể đọc bảng `received_events(id, payload, accepted_at)`. Giữ `id` làm khóa duy nhất ở các bước xử lý tiếp theo; việc webhook đã nhận chỉ chứng minh đã lưu tin, không chứng minh đó là giao dịch ngân hàng hợp lệ. Các thông báo có thể bị rút gọn theo nội dung Android/app nguồn cung cấp.

## Kiểm thử

```sh
node --test server.test.mjs
```

Tests mở HTTP trên loopback với SQLite tạm, kiểm xác thực, Unicode/xuống dòng, sự kiện SMS/thông báo, chống trùng qua restart, xung đột id, dữ liệu sai, giới hạn dung lượng và lỗi database bị khóa. Chưa xác minh DNS/TLS/nginx trên VPS, SIM thật, thông báo ngân hàng thật hoặc E2E điện thoại → VPS; cần kiểm trên môi trường triển khai.
