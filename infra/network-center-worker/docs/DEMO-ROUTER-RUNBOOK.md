# Demo MikroTik — WireGuard/worker runbook

Runbook này dành riêng cho MikroTik dư dùng làm demo. Không áp dụng thẳng lên
router đang phục vụ nhà trọ. Mục tiêu là giữ đường phục hồi LAN cho tới khi
WireGuard, SSH key, host-key pin và polling đều đã được xác minh.

## 0. Điều kiện dừng ngay

Dừng và rollback nếu một trong các điều sau xảy ra:

- máy vận hành mất đường LAN tới router;
- WAN demo mất ngoài khoảng reboot dự kiến;
- fingerprint SSH qua LAN và WireGuard không giống nhau;
- generated file xuất hiện trong Git workspace hoặc log;
- worker cần password SSH, raw RouterOS CLI hoặc service-role key;
- port định cycle đang nối máy Codex/uplink/WAN/WireGuard.

Không apply `router-lockdown.rsc` trong cùng bước với bootstrap.

## 1. Giữ đường phục hồi và chụp trạng thái trước thay đổi

Giữ nguyên topology demo:

```text
Internet/switch -> ether1 (WAN demo)
Máy Codex       -> ether2 (LAN recovery; tuyệt đối không cycle port này)
```

Trong phiên LAN hiện tại, chỉ đọc và lưu evidence cục bộ ngoài repo:

```routeros
/system/identity/print
/system/resource/print
/system/routerboard/print
/interface/print detail without-paging
/ip/address/print detail without-paging
/ip/service/print detail without-paging
/ip/firewall/filter/print detail without-paging
/ip/ssh/print
/user/print detail without-paging
```

Chụp một binary backup mã hóa AES-SHA256 và một export
`terse show-sensitive=no`. Mật khẩu backup phải nằm trong file mode `0600`, không
đưa vào terminal history, chat hoặc commit. Ghi lại SHA-256 của hai artifact; raw
artifact nằm ngoài repo.

## 2. Sinh key và input ngoài repo

Trên VPS, đặt `umask 077`, sinh hai cặp WireGuard riêng cho VPS và router. Sinh
một SSH key Ed25519 riêng cho worker; không tái sử dụng key của 9Router, Zalo,
Supabase hoặc tài khoản quản trị cá nhân.

Tạo input JSON owner-only ở thư mục tạm ngoài Git với các trường:

```json
{
  "routerIdentity": "MikroTik Demo",
  "routerUser": "network-center",
  "routerPassword": "<random 32+ chars; recovery only>",
  "routerWireGuardPrivateKey": "<secret>",
  "routerWireGuardPublicKey": "<public>",
  "vpsWireGuardPrivateKey": "<secret>",
  "vpsWireGuardPublicKey": "<public>",
  "workerSshPublicKey": "ssh-ed25519 <public>",
  "vpsEndpointHost": "<VPS public IP or DNS>",
  "wireGuardPort": 51820,
  "managementCidr": "<dedicated /24>",
  "vpsAddress": "<VPS /24>",
  "vpsPeerAddress": "<VPS /32>",
  "routerAddress": "<router /24>",
  "routerPeerAddress": "<router /32>",
  "recoveryCidr": "<current LAN CIDR>",
  "wanInterface": "<actual WAN interface>"
}
```

Xác minh public key khớp private key bằng `wg pubkey` trước khi tiếp tục. Chạy
generator không dùng CLI arguments và chọn output ngoài repo:

```bash
export NETWORK_BOOTSTRAP_INPUT_FILE=/secure/tmp/demo-input.json
export NETWORK_BOOTSTRAP_OUTPUT_DIR=/secure/tmp/demo-output
node scripts/generate-router-bootstrap.mjs
```

Generator không in nội dung ra stdout. Output gồm:

- `router-bootstrap.rsc`: stage 1, vẫn cho SSH từ LAN recovery;
- `router-lockdown.rsc`: stage 2, chỉ apply sau xác minh;
- `router-rollback.rsc`: gỡ thành phần Network Center và mở lại SSH LAN;
- `worker-ssh-key.pub`;
- `wg0.conf`: cấu hình VPS chứa private key, phải giữ mode `0600`.

## 3. Apply stage 1 qua LAN

1. Giữ nguyên phiên Winbox/SSH LAN đang hoạt động.
2. Upload `worker-ssh-key.pub`, `router-bootstrap.rsc` vào Files của router.
3. Chạy dry-run trước. Demo phải dùng RouterOS 7.16 trở lên; nếu router không hỗ
   trợ `dry-run` thì dừng để nâng cấp/review, không import mù:

   ```routeros
   /import file-name=router-bootstrap.rsc verbose=yes dry-run
   ```

4. Chỉ khi dry-run báo 0 lỗi mới import thật và đọc toàn bộ output trước khi đóng
   phiên:

   ```routeros
   /import file-name=router-bootstrap.rsc verbose=yes
   ```

5. Dù import thành công hay thất bại, xóa ngay script chứa WireGuard private key
   và password khỏi Files. Public key đã import cũng không cần giữ lại:

   ```routeros
   /file/remove [find where name="router-bootstrap.rsc"]
   /file/remove [find where name="worker-ssh-key.pub"]
   ```

6. Xác minh interface `wg-ihome-mgmt`, IP, peer, user/group, SSH key và hai rule
   firewall có comment `iHomeCRM ...`.
7. Không disable admin cũ, không thay default route/NAT/DHCP và chưa import
   lockdown.

Nếu import lỗi giữa chừng, chạy rollback từ phiên LAN còn mở rồi so sánh trạng
thái với evidence bước 1.

## 4. Bring up WireGuard trên VPS

Đặt `wg0.conf` ở vị trí root-owned/owner-only, mở đúng UDP port trên firewall VPS,
rồi bring interface up. Không đưa private key vào `docker-compose.yml`.

Gates bắt buộc:

```bash
wg show wg0
ping -c 3 <router-management-IP>
```

Phải thấy handshake mới và byte counter tăng hai chiều. Container worker dùng
host networking nên chỉ cần host VPS route được management IP; không cấp
`NET_ADMIN` cho container.

## 5. Pin SSH host key đúng cách

Lấy fingerprint SHA256 qua kết nối LAN vật lý đang tin cậy và qua IP WireGuard;
hai fingerprint phải giống nhau. Không tin fingerprint chỉ lấy từ một lần
`ssh-keyscan` trên mạng chưa xác minh.

Sau khi khớp:

- lưu đúng dạng `SHA256:<base64>` trong connection record;
- `credential_ref` chỉ là tên opaque trỏ tới file secrets trên VPS;
- private key và backup password không nằm trong Supabase;
- thử SSH key auth qua WireGuard, không dùng password.

## 6. Polling read-only trước

Deploy worker với `NETWORK_CENTER_EMERGENCY_STOP=true`. Gate read-only:

- heartbeat `PAUSED`/fresh;
- router current state, interfaces, clients và Aruba discovery cập nhật;
- Aruba được chunk 256/batch nhưng không có quota tổng;
- Aruba có `write_capability=false`, không credential, không action;
- inventory ổn định được cache, ingest nhiều tòa được gộp;
- snapshot trình duyệt chỉ có export đã redact và SHA-256;
- không có worker secret/private key/password trong log, Realtime hoặc RPC đọc.

Chỉ khi các gate trên xanh mới đổi emergency stop sang `false` và restart riêng
container Network Center.

## 7. Apply lockdown riêng biệt

Import `router-lockdown.rsc` qua phiên WireGuard đã xác minh. Ngay sau import:

- mở phiên SSH mới qua WireGuard trước khi đóng phiên cũ;
- xác minh SSH chỉ nhận từ VPS peer `/32`;
- Winbox chỉ nằm trên management CIDR;
- telnet/FTP service/web/API bị disable (SFTP trong SSH vẫn hoạt động);
- LAN không còn là đường quản trị bình thường; giữ cáp và rollback file cho tình
  huống khẩn cấp vật lý.

## 8. Thử bốn action đóng

Thử tuần tự và kiểm audit/stage ở mỗi bước:

1. `FLUSH_DNS_CACHE`: backup -> execute -> DNS post-check.
2. `RENEW_DHCP_LEASE`: nếu WAN dùng DHCP, renew và post-check; nếu PPPoE/không có
   DHCP bound, kết quả phải là `NO_BOUND_DHCP_CLIENT`, không coi là lỗi.
3. `CYCLE_ACCESS_PORT`: chỉ chọn port ACCESS trống (ví dụ ether5 sau khi kiểm
   tra). Không chọn ether1, ether2, SFP/uplink, bridge hay WireGuard.
4. `REBOOT_ROUTER`: làm cuối cùng; xác minh `UNCERTAIN`/reconciliation nếu SSH
   rớt sau khi lệnh đã gửi, và không tự reboot lần hai.

Mỗi action phải có lease renewal, pre-backup AES-SHA256, redacted snapshot,
event stages, post-check và audit. User có `network_center.execute` chạy ngay;
không có approval workflow.

## 9. Rollback

Nếu WireGuard/SSH worker không ổn định:

1. dùng phiên LAN recovery còn mở;
2. import `router-rollback.rsc`;
3. xác minh SSH LAN hoạt động lại;
4. giữ binary backup/export để điều tra nhưng không commit;
5. xóa/rotate key và worker secret bị nghi lộ;
6. chỉ khôi phục binary backup khi rollback script không đủ và đã xác nhận đúng
   router/model/RouterOS version.

Evidence được phép commit chỉ gồm test, runbook, hash và kết luận đã redact; không
commit IP thật, host key, WireGuard key, SSH key, password, raw export hoặc binary
backup.
