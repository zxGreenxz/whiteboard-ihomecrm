# Dashboard Hermes owner

Các asset này dành riêng cho VPS có `hermes-owner` (UID/GID `10003:10003`, profile bind `/var/lib/ihome-hermes-profiles/owner` → `/home/hermes`) dùng network namespace của `ihome-zalo-worker`. Bản pin: **v0.22.2**, Linux amd64, manifest `sha256:a11574b7fe8e1631d7d88d556677dac693bc058abf558cdeb899155688c1bf05`. Phải nâng owner lên đúng pin và xác minh backup/provenance trước khi bật dashboard. Không dùng tag mutable.

Dashboard là container riêng, chia sẻ network **và PID namespace** với owner để thấy đúng gateway. Chỉ nghe `127.0.0.1:9119` trong namespace này. Container không có published port, chạy non-root, filesystem chỉ đọc ngoài profile và tmpfs, bỏ capabilities, hạn chế RAM 384 MiB và 128 PID. Nó có quyền quản trị profile owner; startup có thể đối soát state.db và khôi phục trạng thái. Việc triển khai không phải phép đọc thuần.

Host socket chỉ nghe `127.0.0.1:19119`. Proxy kiểm owner/image/profile/namespace đang sống ở mỗi lần khởi động. Node spawn shell với ánh xạ FD 3 tường minh; shell đặt `LISTEN_PID` bằng PID của nó rồi exec `nsenter` và `systemd-socket-proxyd`, giữ listener qua các lần exec. Node giám sát child và chuyển tiếp tín hiệu dừng. TCP forwarding giữ nguyên HTTP Host, `X-Forwarded-Proto` và WebSocket. Không lưu PID cố định. Các unit `PartOf`/`BindsTo` dừng socket/proxy khi dashboard dừng; restart tạo lại đường vào. Khi PID 1 của owner dừng, kernel kết thúc tiến trình trong shared PID namespace, wrapper báo lỗi tạm thời để systemd khởi động lại sau 5 giây. Mã 75 là prerequisite chưa sẵn sàng; mã 78 là cấu hình sai, không tự retry. Có khoảng đua ngắn giữa đọc PID owner và `nsenter`; phép kiểm restart trên VPS vẫn cần xác nhận vòng đời thực tế.

## Cài đặt

1. Kiểm exact image của owner, image frontend có `web/dist` sử dụng được, profile/backup, và gateway hiện tại. Companion không kế thừa writable layer của owner. Không build frontend trong container runtime chỉ đọc.
2. Đóng gói bảy file trong thư mục source này vào release độc lập `/opt/ihome-hermes-dashboard/releases/<reviewed-commit-sha>/`, giữ `launcher.mjs` ngay tại gốc release. Kiểm digest, owner root và quyền file, rồi trỏ symlink `/opt/ihome-hermes-dashboard/current` tới release đã kiểm. Mỗi release bất biến; các unit dùng `/opt/ihome-hermes-dashboard/current/launcher.mjs`. Node dùng chung tại `/opt/ihome-hermes/node/bin/node`, pin **24.18.0** theo runtime manifest; Docker, `nsenter`, `/lib/systemd/systemd-socket-proxyd` phải sẵn có. Thao tác này không ghi vào release CRM `/opt/ihome-hermes/current`.
3. Tạo file **root:root 0600, regular file không symlink** `/etc/ihome-hermes/dashboard.env`, chứa đúng các khóa dưới. Launcher không tạo mật khẩu, không in giá trị, không đưa secret vào argv. Docker nhận file qua `--env-file`, nên người có quyền Docker/root có thể đọc môi trường container. Không lưu file này trong Git.

```text
HERMES_DASHBOARD_PUBLIC_URL=https://crm-hermes.chillhome.io.vn
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=<tên đăng nhập>
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=<hash scrypt của mật khẩu>
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<ít nhất 32 byte ngẫu nhiên, base64url không padding>
```

Tạo hash bằng hàm `plugins.dashboard_auth.basic.hash_password` của exact image; đưa mật khẩu qua nhập ẩn/stdin, không đặt trong câu lệnh. Có thể thêm `HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS`. Không đặt plaintext password hoặc `HERMES_DESKTOP`. `public_url` buộc auth dù backend bind loopback. Khi thu hồi phiên, đổi cả signing secret: provider basic có refresh token 30 ngày, đổi mật khẩu riêng không thu hồi token cũ.

4. Cài ba unit vào `/etc/systemd/system/`, `systemctl daemon-reload`, rồi `systemctl enable --now hermes-dashboard.service`. Unit socket được kéo theo; không cần bật riêng proxy service.
5. Kiểm tại host với Host `crm-hermes.chillhome.io.vn` và `X-Forwarded-Proto: https`: `/login` 200; API được bảo vệ 401 trước đăng nhập; login đúng 200; API sau login 200; cookie Secure/HttpOnly/SameSite=Lax; Host sai bị từ chối. Kiểm đăng nhập và WebSocket thật trên trình duyệt trước khi kết luận hoàn tất.
6. Kiểm stop/restart đóng/mở đúng port, companion mất theo owner restart và tự trở lại sau prerequisite phục hồi. Giữ đầy đủ bằng chứng nguồn, bản pin, config digest và backup trước đổi ingress.

## Cloudflared

Giữ backup cấu hình tunnel. Chèn hai rule cho hostname **theo đúng thứ tự**, giữ các hostname khác nguyên trạng:

```yaml
- hostname: crm-hermes.chillhome.io.vn
  path: ^/(mcp|api/hermes/(connections|zalo)/.*)$
  service: http://127.0.0.1:8740
- hostname: crm-hermes.chillhome.io.vn
  service: http://127.0.0.1:19119
```

Không dành toàn bộ `/api/hermes/*` cho connector: dashboard có `/api/hermes/update`, `/api/hermes/update/check`, `/api/hermes/update/receipt`. Kiểm rule matcher cho connector và dashboard trước reload tunnel. HTTPS phải được forward dưới `X-Forwarded-Proto: https`; `Host` phải giữ hostname public. Cloudflare Access nếu thêm phải tránh chặn các route connector đang dùng cho machine access.

## Dừng, khôi phục

`systemctl stop hermes-dashboard.service` dừng socket/proxy rồi dừng đúng companion CID đã ghi tại `/var/lib/ihome-hermes-dashboard/container.json`. Launcher kiểm exact image, tên, labels và owner namespaces trước `docker stop --time 30` và `docker rm`. Không tìm/xóa container bất kỳ bằng pattern. Nếu có tên container nhưng không có record, launcher dừng với mã 78; kiểm identity thủ công trước recovery, không xóa mù.

Rollback ingress bằng bản backup đã kiểm rồi dừng dashboard. Không rollback schema/state.db tự động. Trước khi đổi symlink `current`, dừng deployment bằng launcher cũ và xác nhận companion đã dừng; sau đó chuyển symlink nguyên tử sang release dashboard đã kiểm dưới `/opt/ihome-hermes-dashboard/releases/<sha>`, cài unit tương ứng và reload systemd. Nếu đổi bản pin, xác minh owner image khớp release mới trước khi bật lại. Thư mục state giữ qua restart/reboot để có thể dọn đúng CID sau crash. Trường hợp crash đúng giữa Docker create và ghi record cần xác minh thủ công container cùng tên.

Kiểm source: `node --test infra/hermes-runtime/dashboard/launcher.test.mjs`. Các test xác minh contract launch/identity/auth/namespace, không thay thế kiểm systemd/Docker, xác thực public hay UI trên VPS.
