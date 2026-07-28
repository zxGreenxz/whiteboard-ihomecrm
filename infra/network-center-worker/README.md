# iHomeCRM Network Center worker

Worker Node.js riêng cho MikroTik Network Center. Tiến trình này chạy trên VPS,
gọi Edge API hẹp bằng `x-network-worker-secret`, rồi kết nối SSH tới MikroTik qua
địa chỉ quản trị WireGuard. Trình duyệt và Supabase không bao giờ nhận private key,
mật khẩu backup hay lệnh RouterOS tùy ý.

## Phạm vi

- Đọc inventory, telemetry, DHCP client và RouterOS neighbor.
- Aruba chỉ được phát hiện/hiển thị; không có credential và không có thao tác ghi.
- Aruba không có quota tổng. Mỗi request inventory tối đa 256 Aruba và worker gửi
  lặp bao nhiêu batch cũng được.
- Chỉ có bốn thay đổi RouterOS đóng: flush DNS cache, renew DHCP lease, cycle một
  access port đã được DB xác nhận, và reboot router.
- Mọi thay đổi có lease, backup mã hóa, export đã che sensitive, post-check, audit
  và reconciliation. Worker không nhận raw RouterOS CLI từ API hay người gọi.

## Secret files

`.env` chỉ chứa cấu hình không bí mật. Tạo thư mục secrets trên VPS, không nằm
trong repo:

```text
/opt/ihome-network-center/secrets/
  worker-secret
  router-credentials.json
  router-demo-key
  router-demo-backup-password
```

Mỗi file phải thuộc UID/GID `10001:10001`, mode `0600` (hoặc chặt hơn nhưng vẫn
đọc được bởi UID 10001). `router-credentials.json` chỉ chứa tham chiếu file:

```json
{
  "router/demo": {
    "username": "network-center",
    "privateKeyFile": "/run/secrets/network-center/router-demo-key",
    "backupPasswordFile": "/run/secrets/network-center/router-demo-backup-password"
  }
}
```

Không dùng password SSH; worker yêu cầu key authentication và fingerprint
`SHA256:...` được pin trong connection record. Không truyền secret qua CLI hoặc
biến môi trường inline.

## Chạy kiểm thử

Yêu cầu Node 20:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Container:

```bash
cp .env.example .env
docker compose build
docker compose up -d
docker compose ps
```

Compose chạy non-root, root filesystem read-only, drop toàn bộ Linux capability,
không mount Docker socket, dùng host networking để đi tới WireGuard và giới hạn
0.5 CPU / 512 MiB RAM / 128 process. Worker này độc lập, không đọc hoặc restart
9Router/Zalo.

## Kill switch và vận hành

- Giữ `NETWORK_CENTER_EMERGENCY_STOP=true` trong lần deploy đầu. Polling vẫn đọc
  trạng thái nhưng mọi command được hoàn tất ở trạng thái
  `CANCELLED_BY_KILL_SWITCH` trước khi mở SSH.
- Sau khi heartbeat, WireGuard, host-key pin và read-only polling đều xanh, đổi
  thành `false` rồi restart riêng container này.
- `changesPaused` theo từng tòa là kill switch thứ hai và được kiểm tra lại trước
  khi kết nối router.
- Healthcheck đọc timestamp tại `/tmp/network-center-worker-health`; log JSON được
  rotate ở 3 file x 10 MiB và mọi key/secret/token/password đều bị che.
- Binary backup mã hóa AES-SHA256 chỉ nằm trong volume VPS. Supabase chỉ nhận
  export `show-sensitive=no` đã redaction lần hai và SHA-256.

## Mô hình lỗi

- Lỗi kết nối trước thao tác: retry có backoff.
- Lỗi vĩnh viễn/validation: `FAILED`.
- Cycle port hoặc reboot bị mất kết nối sau khi đã gửi lệnh: `UNCERTAIN`, không
  tự chạy lại. Queue sẽ phát reconciliation claim; worker chỉ post-check, không
  lặp thao tác disruptive.
- SIGTERM/SIGINT abort hai loop, đợi công việc đang chạy, gửi heartbeat `STOPPING`
  rồi thoát trong `stop_grace_period`.
